<?php
/**
 * The participant page's server functions. Phase 0 registers getSessionState's not-found answer
 * (enough to prove the transport end to end); phase 2 ports the rest of server/participants.js.
 */

defined( 'ABSPATH' ) || exit;

class QD_Participants {

	public static function init() {
		QD_Api::register( 'getSessionState', array( __CLASS__, 'get_session_state' ), 'public' );
	}

	/** Same answer shape as participantState_() for a session that doesn't exist. */
	public static function get_session_state( $sid = '', $device_id = '' ) {
		return array( 'found' => false );
	}
}
