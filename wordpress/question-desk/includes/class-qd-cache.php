<?php
/**
 * Short-lived values (CacheService in the Apps Script version): the phone topic list, the
 * queue board, device and cooldown marks, the per-minute caps.
 *
 * Transients, so a host with a persistent object cache keeps them out of the database.
 * Per-session values carry the session's cache version, replaced by every invalidate(), so a
 * request that read the questions before a change can never cache its result afterwards —
 * that race brought dismissed questions back in the Apps Script version.
 */

defined( 'ABSPATH' ) || exit;

class QD_Cache {

	const VERSION_SECONDS = 21600;   // 6h, as the Apps Script cache allows

	public static function get( $key ) {
		$value = get_transient( 'qd_' . $key );
		return false === $value ? null : $value;
	}

	public static function set( $key, $value, $seconds ) {
		set_transient( 'qd_' . $key, $value, (int) $seconds );
	}

	public static function forget( $key ) {
		delete_transient( 'qd_' . $key );
	}

	/** Adds $by to a counter that lives $seconds, and answers the new total. */
	public static function bump( $key, $seconds, $by = 1 ) {
		$now = (int) self::get( $key ) + (int) $by;
		self::set( $key, $now, $seconds );
		return $now;
	}

	public static function version( $sid ) {
		$version = self::get( 'ver_' . $sid );
		if ( ! $version ) {
			$version = QD_Util::new_id( 12 );
			self::set( 'ver_' . $sid, $version, self::VERSION_SECONDS );
		}
		return $version;
	}

	/** A session's cached value, or build() it and cache it under the version read first. */
	public static function for_session( $sid, $name, $seconds, callable $build ) {
		$version = self::version( $sid );
		$entry   = self::get( $name . '_' . $sid );
		if ( is_array( $entry ) && isset( $entry['v'] ) && $entry['v'] === $version ) {
			return $entry['data'];
		}
		$data = $build();
		self::set( $name . '_' . $sid, array( 'v' => $version, 'data' => $data ), $seconds );
		return $data;
	}

	/** After anything that changes a session's questions, topics or languages. */
	public static function invalidate( $sid ) {
		self::set( 'ver_' . $sid, QD_Util::new_id( 12 ), self::VERSION_SECONDS );
		self::forget( 'topics_' . $sid );
		self::forget( 'board_' . $sid );
	}
}
