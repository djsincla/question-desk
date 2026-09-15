<?php
/**
 * The questions table: what phase 1 needs (counts, prepared questions, deleting a session's
 * rows). Asking, grouping and the queue come in phases 2 and 4.
 */

defined( 'ABSPATH' ) || exit;

class QD_Questions {

	/** Questions per session, not counting prepared ones. */
	public static function counts() {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT session_id, COUNT(*) AS n FROM " . QD_Install::table( 'questions' ) . " WHERE status <> 'prepared' GROUP BY session_id" ); // phpcs:ignore WordPress.DB.PreparedSQL
		$out  = array();
		foreach ( $rows as $row ) {
			$out[ $row->session_id ] = (int) $row->n;
		}
		return $out;
	}

	/** The prepared questions of every session, in the order they were added. */
	public static function prepared() {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT session_id, text FROM " . QD_Install::table( 'questions' ) . " WHERE status = 'prepared' ORDER BY submitted, id" ); // phpcs:ignore WordPress.DB.PreparedSQL
		$out  = array();
		foreach ( $rows as $row ) {
			$out[ $row->session_id ][] = (string) $row->text;
		}
		return $out;
	}

	public static function prepared_for( $sid ) {
		return self::prepared()[ $sid ] ?? array();
	}

	/** Replaces a session's unused prepared questions; ones already added to the queue stay (setPrepared_). */
	public static function set_prepared( $sid, array $list ) {
		global $wpdb;
		QD_Util::with_lock( 'questions:' . $sid, function () use ( $wpdb, $sid, $list ) {
			$wpdb->delete( QD_Install::table( 'questions' ), array( 'session_id' => $sid, 'status' => 'prepared' ) );
			$now = QD_Util::now_ms();
			// A millisecond apart each, so they keep the order they were typed in (usePrepared
			// re-timestamps them when they reach the queue anyway).
			foreach ( $list as $i => $text ) {
				$wpdb->insert(
					QD_Install::table( 'questions' ),
					array(
						'id'           => QD_Util::new_id( 8 ),
						'session_id'   => $sid,
						'submitted'    => $now + $i,
						'device'       => 'prepared',
						'text'         => $text,
						'status'       => 'prepared',
						'translation'  => '',
						'translations' => '',
					)
				);
			}
		} );
	}

	public static function delete_for_session( $sid ) {
		global $wpdb;
		$wpdb->delete( QD_Install::table( 'questions' ), array( 'session_id' => $sid ) );
		$wpdb->delete( QD_Install::table( 'topics' ), array( 'session_id' => $sid ) );
		$wpdb->delete( QD_Install::table( 'votes' ), array( 'session_id' => $sid ) );
	}
}
