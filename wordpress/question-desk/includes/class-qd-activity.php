<?php
/**
 * The activity log: who changed what, when (activity.js). Staff actions only, never
 * participants' questions. Never throws: a logging failure must not undo an action.
 */

defined( 'ABSPATH' ) || exit;

class QD_Activity {

	/** Set while an import or the schedule acts, like EXEC_.auditVia / auditWho. */
	public static $via = '';
	public static $who = '';

	/**
	 * @param string     $action  e.g. 'Session created'.
	 * @param array|null $target  A session, or an event as array('id' => …, 'eventName' => …).
	 * @param string     $details Short details.
	 */
	public static function log( $action, $target, $details ) {
		try {
			global $wpdb;
			$who   = self::$who ? self::$who : ( QD_People::current_email() ? QD_People::current_email() : 'unknown' );
			$label = '';
			if ( $target ) {
				$label = array_key_exists( 'eventName', $target ) ? (string) $target['eventName']
					: ( QD_Store::event_name( $target ) ? QD_Store::event_name( $target ) . ' — ' : '' ) . (string) ( $target['name'] ?? '' );
			}
			$wpdb->insert(
				QD_Install::table( 'activity' ),
				array(
					'at'        => QD_Util::now_ms(),
					'who'       => mb_substr( $who, 0, 200 ),
					'action'    => mb_substr( (string) $action, 0, 200 ),
					'target'    => mb_substr( $label, 0, 200 ),
					'target_id' => (string) ( $target['id'] ?? '' ),
					'details'   => mb_substr( (string) $details . ( self::$via ? ' (' . self::$via . ')' : '' ), 0, 1000 ),
				)
			);
		} catch ( Throwable $e ) {
			error_log( 'Question Desk activity log: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}
	}

	/** Newest first. options: { query, target, limit }. */
	public static function get( $options = array() ) {
		QD_People::require_admin();
		global $wpdb;
		$options = (array) $options;
		$table   = QD_Install::table( 'activity' );
		$where   = array( '1=1' );
		$params  = array();
		if ( ! empty( $options['target'] ) ) {
			$where[]  = 'target_id = %s';
			$params[] = (string) $options['target'];
		}
		$query = trim( (string) ( $options['query'] ?? '' ) );
		if ( '' !== $query ) {
			$like     = '%' . $wpdb->esc_like( $query ) . '%';
			$where[]  = '(who LIKE %s OR action LIKE %s OR target LIKE %s OR details LIKE %s)';
			$params   = array_merge( $params, array( $like, $like, $like, $like ) );
		}
		$limit    = min( (int) ( $options['limit'] ?? 200 ) ?: 200, 500 );
		$sql      = "SELECT at, who, action, target_id, target, details FROM $table WHERE " . implode( ' AND ', $where ) . ' ORDER BY at DESC, id DESC LIMIT ' . $limit;
		$rows     = $params ? $wpdb->get_results( $wpdb->prepare( $sql, $params ) ) : $wpdb->get_results( $sql ); // phpcs:ignore WordPress.DB.PreparedSQL
		$total    = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $table" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$entries  = array_map( function ( $r ) {
			return array( 'at' => (int) $r->at, 'who' => $r->who, 'action' => $r->action, 'target' => $r->target_id, 'label' => $r->target, 'details' => $r->details );
		}, $rows );
		return array( 'entries' => $entries, 'total' => $total, 'scanned' => $total );
	}

	/** A short "what changed" for a session edit (sessionChanges_). */
	public static function session_changes( array $before, array $after ) {
		$labels = array(
			'name' => 'name', 'heading' => 'heading', 'access' => 'how people join', 'theme' => 'theme', 'maxLength' => 'length limit',
			'cooldownSeconds' => 'wait between questions', 'moderators' => 'QA Facilitators', 'emailOnEnd' => 'summary email',
			'scheduledStart' => 'scheduled start', 'scheduledEnd' => 'scheduled end', 'brand' => 'session branding',
			'guestPage' => 'guest page', 'eventId' => 'event',
		);
		$out = array();
		foreach ( $labels as $key => $label ) {
			if ( wp_json_encode( $before[ $key ] ?? null ) === wp_json_encode( $after[ $key ] ?? null ) ) {
				continue;
			}
			$out[] = 'name' === $key ? 'renamed from "' . $before['name'] . '"'
				: ( 'eventId' === $key ? 'event: ' . ( QD_Store::event_name( $after ) ?: 'none' ) : $label );
		}
		return implode( ', ', $out );
	}
}
