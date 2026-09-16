<?php
/**
 * Sessions and events: one row each, with the same fields the Apps Script version keeps in
 * Script Properties (camelCase, in the data column). A few are copied into columns for queries.
 */

defined( 'ABSPATH' ) || exit;

class QD_Store {

	/** @var array per-request cache, cleared on every write */
	private static $sessions = null;
	private static $events   = null;

	public static function reset_cache() {
		self::$sessions = null;
		self::$events   = null;
	}

	// ------------------------------------------------------------ sessions

	public static function get_session( $sid ) {
		$sid = (string) $sid;
		if ( ! preg_match( QD_Util::ID_RE, $sid ) ) {
			return null;
		}
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT data FROM ' . QD_Install::table( 'sessions' ) . ' WHERE id = %s', $sid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		return $row ? QD_Util::json_array( $row->data ) : null;
	}

	public static function save_session( array $session ) {
		global $wpdb;
		$wpdb->replace(
			QD_Install::table( 'sessions' ),
			array(
				'id'       => $session['id'],
				'event_id' => (string) ( $session['eventId'] ?? '' ),
				'name'     => (string) ( $session['name'] ?? '' ),
				'status'   => (string) ( $session['status'] ?? 'inactive' ),
				'sort'     => (int) ( $session['order'] ?? 0 ),
				'data'     => wp_json_encode( $session ),
				'created'  => (int) ( $session['created'] ?? 0 ),
			)
		);
		self::reset_cache();
	}

	public static function delete_session_row( $sid ) {
		global $wpdb;
		$wpdb->delete( QD_Install::table( 'sessions' ), array( 'id' => $sid ) );
		self::reset_cache();
	}

	/** Sessions in the admin's order; sessions never reordered sort newest first (allSessions_). */
	public static function all_sessions() {
		if ( null === self::$sessions ) {
			global $wpdb;
			$rows           = $wpdb->get_col( 'SELECT data FROM ' . QD_Install::table( 'sessions' ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
			self::$sessions = self::sorted( array_map( array( 'QD_Util', 'json_array' ), $rows ) );
		}
		return self::$sessions;
	}

	/** Changes a session under its lock and saves it (updateSession_). */
	public static function update_session( $sid, callable $mutate ) {
		return QD_Util::with_lock(
			'session:' . $sid,
			function () use ( $sid, $mutate ) {
				$session = self::get_session( $sid );
				if ( ! $session ) {
					throw new QD_Error( 'Session not found.' );
				}
				$mutate( $session );
				self::save_session( $session );
				return $session;
			}
		);
	}

	// ------------------------------------------------------------ events

	public static function get_event( $eid ) {
		$eid = (string) $eid;
		if ( ! preg_match( QD_Util::ID_RE, $eid ) ) {
			return null;
		}
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT data FROM ' . QD_Install::table( 'events' ) . ' WHERE id = %s', $eid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		return $row ? QD_Util::json_array( $row->data ) : null;
	}

	public static function save_event( array $event ) {
		global $wpdb;
		$wpdb->replace(
			QD_Install::table( 'events' ),
			array(
				'id'      => $event['id'],
				'name'    => (string) ( $event['name'] ?? '' ),
				'sort'    => (int) ( $event['order'] ?? 0 ),
				'data'    => wp_json_encode( $event ),
				'created' => (int) ( $event['created'] ?? 0 ),
			)
		);
		self::reset_cache();
	}

	public static function delete_event_row( $eid ) {
		global $wpdb;
		$wpdb->delete( QD_Install::table( 'events' ), array( 'id' => $eid ) );
		self::reset_cache();
	}

	public static function all_events() {
		if ( null === self::$events ) {
			global $wpdb;
			$rows         = $wpdb->get_col( 'SELECT data FROM ' . QD_Install::table( 'events' ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
			self::$events = self::sorted( array_map( array( 'QD_Util', 'json_array' ), $rows ) );
		}
		return self::$events;
	}

	public static function event_name( $session ) {
		$ev = $session && ! empty( $session['eventId'] ) ? self::get_event( $session['eventId'] ) : null;
		return $ev ? (string) $ev['name'] : '';
	}

	/** By order, then newest first; unordered items sort by -created (like the Apps Script sort). */
	private static function sorted( array $items ) {
		usort(
			$items,
			function ( $a, $b ) {
				$oa = isset( $a['order'] ) && is_numeric( $a['order'] ) ? $a['order'] : -( $a['created'] ?? 0 );
				$ob = isset( $b['order'] ) && is_numeric( $b['order'] ) ? $b['order'] : -( $b['created'] ?? 0 );
				return ( $oa <=> $ob ) ?: ( ( $b['created'] ?? 0 ) <=> ( $a['created'] ?? 0 ) );
			}
		);
		return $items;
	}
}
