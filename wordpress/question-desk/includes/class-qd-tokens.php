<?php
/**
 * Getting into a session: the rotating room code on the screen, and the device token a phone
 * keeps afterwards (roomToken_, validCredential_, deviceValid_).
 *
 * The audience is anonymous — no accounts, no IP addresses — so the room code is what ties
 * asking to being in the room: it changes every CONFIG.entryTokenSeconds, and a link forwarded
 * out of the room goes dead. Device tokens are per session: joining one grants nothing in another.
 */

defined( 'ABSPATH' ) || exit;

class QD_Tokens {

	const DEVICE_RE = '/^[a-f0-9-]{36}$/';

	private static function window_ms() {
		return (int) QD_App::config( 'entryTokenSeconds' ) * 1000;
	}

	private static function stored( $sid ) {
		$raw = get_option( 'qd_token_' . $sid, '' );
		return $raw ? QD_Util::json_array( $raw ) : null;
	}

	/** The code to show in the room, rotating when it has expired (roomToken_). */
	public static function room_token( $sid ) {
		$window = self::window_ms();
		$tok    = self::stored( $sid );
		if ( ! $tok || QD_Util::now_ms() - $tok['issued'] > $window ) {
			$tok = QD_Util::with_lock( 'token:' . $sid, function () use ( $sid, $window ) {
				$fresh = self::stored( $sid );
				if ( $fresh && QD_Util::now_ms() - $fresh['issued'] <= $window ) {
					return $fresh;
				}
				// The old code carries over only if it was on screen a moment ago. Once the
				// screen has been shut a while, a photographed code must stay dead.
				$recent = $fresh && QD_Util::now_ms() - $fresh['issued'] <= $window * 2;
				$next   = array(
					'current'        => QD_Util::new_id( 12 ),
					'previous'       => $recent ? $fresh['current'] : '',
					'previousIssued' => $recent ? $fresh['issued'] : 0,
					'issued'         => QD_Util::now_ms(),
				);
				update_option( 'qd_token_' . $sid, wp_json_encode( $next ), false );
				return $next;
			} );
		}
		return array(
			'token'     => $tok['current'],
			'expiresIn' => max( 1, (int) ceil( ( $tok['issued'] + $window - QD_Util::now_ms() ) / 1000 ) ),
		);
	}

	public static function clear_room_token( $sid ) {
		delete_option( 'qd_token_' . $sid );
	}

	/**
	 * A shown code is good for its own window and one more; a rotated-out code for a little
	 * longer, so a scan during a rotation still works. Nothing rotates without a room screen
	 * polling, so the age is checked here rather than assumed (validCredential_).
	 */
	public static function valid_credential( array $session, $credential ) {
		if ( ! is_string( $credential ) || '' === $credential || strlen( $credential ) > 64 ) {
			return false;
		}
		if ( 'link' === ( $session['access'] ?? '' ) ) {
			return hash_equals( (string) ( $session['linkKey'] ?? '' ), $credential );
		}
		$tok = self::stored( $session['id'] );
		if ( ! $tok ) {
			return false;
		}
		$window = self::window_ms();
		$age    = QD_Util::now_ms() - $tok['issued'];
		if ( hash_equals( (string) $tok['current'], $credential ) ) {
			return $age <= $window * 2;
		}
		if ( $tok['previous'] && hash_equals( (string) $tok['previous'], $credential ) ) {
			return $age <= $window && $tok['previousIssued'] && QD_Util::now_ms() - $tok['previousIssued'] <= $window * 3;
		}
		return false;
	}

	// ------------------------------------------------------------ device tokens

	public static function new_device( $sid ) {
		$device = wp_generate_uuid4();
		QD_Cache::set( 'dev_' . $sid . '_' . $device, 1, (int) QD_App::config( 'deviceTokenSeconds' ) );
		return $device;
	}

	public static function device_shape( $device_id ) {
		return is_string( $device_id ) && preg_match( self::DEVICE_RE, $device_id );
	}

	public static function device_valid( $sid, $device_id ) {
		return self::device_shape( $device_id ) && null !== QD_Cache::get( 'dev_' . $sid . '_' . $device_id );
	}
}
