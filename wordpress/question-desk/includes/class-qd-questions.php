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

	/**
	 * A session's questions (sessionRows_). Prepared ones are left out unless asked for: until
	 * a facilitator adds them they are not questions anyone asked.
	 */
	public static function rows( $sid, $include_prepared = false ) {
		global $wpdb;
		$sql  = 'SELECT * FROM ' . QD_Install::table( 'questions' ) . ' WHERE session_id = %s';
		$args = array( $sid );
		if ( ! $include_prepared ) {
			$sql .= " AND status <> 'prepared'";
		}
		$rows = $wpdb->get_results( $wpdb->prepare( $sql . ' ORDER BY submitted, id', $args ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		return array_map( array( __CLASS__, 'row' ), $rows );
	}

	public static function get( $id ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . QD_Install::table( 'questions' ) . ' WHERE id = %s', $id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		return $row ? self::row( $row ) : null;
	}

	private static function row( $r ) {
		return array(
			'id'           => (string) $r->id,
			'sessionId'    => (string) $r->session_id,
			'text'         => (string) $r->text,
			'device'       => (string) $r->device,
			// '?' only ever meant "leave this one out of grouping", never a language.
			'lang'         => ( $r->lang && '?' !== $r->lang ) ? (string) $r->lang : '',
			'translation'  => (string) $r->translation,
			'topic'        => (string) $r->topic,
			'translations' => QD_Util::json_array( $r->translations ),
			'grouping'     => (string) $r->grouping,
			// About running the event, and whether a coordinator has dealt with it.
			'logistics'    => '' !== (string) $r->logistics,
			'sorted'       => 'sorted' === (string) $r->logistics,
			'status'       => (string) $r->status,
			'submitted'    => (int) $r->submitted,
		);
	}

	/** Saves one asked question. One row, one INSERT: no inbox and no lock needed here. */
	public static function insert( $sid, $device_id, $text ) {
		global $wpdb;
		$id = QD_Util::new_id( 8 );
		$ok = $wpdb->insert(
			QD_Install::table( 'questions' ),
			array(
				'id'           => $id,
				'session_id'   => $sid,
				'submitted'    => QD_Util::now_ms(),
				'device'       => $device_id ? $device_id : 'unknown',
				'text'         => $text,
				'status'       => 'new',
				'translation'  => '',
				'translations' => '',
			)
		);
		if ( ! $ok ) {
			return '';
		}
		QD_Cache::invalidate( $sid );
		return $id;
	}

	public static function delete_for_session( $sid ) {
		global $wpdb;
		$wpdb->delete( QD_Install::table( 'questions' ), array( 'session_id' => $sid ) );
		$wpdb->delete( QD_Install::table( 'topics' ), array( 'session_id' => $sid ) );
		$wpdb->delete( QD_Install::table( 'votes' ), array( 'session_id' => $sid ) );
	}
}
