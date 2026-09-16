<?php
/**
 * The participant page: joining, asking, the wait between questions, and Me too
 * (participants.js in the Apps Script version).
 *
 * Everyone here is anonymous: these are the only functions the REST route lets anyone call.
 */

defined( 'ABSPATH' ) || exit;

class QD_Participants {

	public static function init() {
		QD_Api::register( 'getSessionState', array( __CLASS__, 'get_session_state' ), 'public' );
		QD_Api::register( 'claimDevice', array( __CLASS__, 'claim_device' ), 'public' );
		QD_Api::register( 'submitQuestion', array( __CLASS__, 'submit_question' ), 'public' );
		QD_Api::register( 'getTopics', array( __CLASS__, 'get_topics' ), 'public' );
		QD_Api::register( 'meToo', array( __CLASS__, 'me_too' ), 'public' );
	}

	/** What the page needs to draw itself, whether or not this phone has joined. */
	public static function get_session_state( $sid = '', $device_id = '' ) {
		$session = QD_Store::get_session( $sid );
		$state   = self::state( $session );
		if ( ! $session ) {
			return $state;
		}
		$state['deviceValid']       = QD_Tokens::device_valid( $sid, $device_id );
		$state['cooldownRemaining'] = QD_Tokens::device_shape( $device_id ) ? self::cooldown_remaining( $session, $device_id ) : 0;
		$state['cooldownSeconds']   = self::cooldown_for( $session );
		return $state;
	}

	private static function state( $session ) {
		if ( ! $session ) {
			return array( 'found' => false );
		}
		return array(
			'found'     => true,
			'status'    => (string) $session['status'],
			'open'      => false !== ( $session['open'] ?? true ),
			'access'    => (string) $session['access'],
			'heading'   => (string) ( $session['heading'] ?? '' ) ?: 'Questions for the panel',
			'maxLength' => (int) ( $session['maxLength'] ?? QD_App::config( 'defaultMaxLength' ) ),
		);
	}

	/** Exchanges a room code or link key for the device token the browser keeps (claimDevice). */
	public static function claim_device( $sid = '', $credential = '' ) {
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		if ( 'ended' === $session['status'] ) {
			return array( 'ok' => false, 'reason' => 'ended' );
		}
		if ( ! QD_Tokens::valid_credential( $session, $credential ) ) {
			return array( 'ok' => false, 'reason' => 'expired' );
		}
		$device = QD_Tokens::new_device( $sid );
		return array( 'ok' => true, 'deviceId' => $device, 'state' => self::get_session_state( $sid, $device ) );
	}

	public static function submit_question( $sid = '', $device_id = '', $text = '', $credential = '' ) {
		return self::submit( $sid, $device_id, $text, $credential, false );
	}

	/** $skip_room_cap is only ever true for load-test submissions (phase 5). */
	public static function submit( $sid, $device_id, $text, $credential, $skip_room_cap ) {
		if ( ! is_string( $text ) || strlen( $text ) > (int) QD_App::config( 'maxLengthCeiling' ) * 2 ) {
			return array( 'ok' => false, 'reason' => 'tooLong' );   // refuse the oversized before any work
		}
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		if ( 'ended' === $session['status'] ) {
			return array( 'ok' => false, 'reason' => 'ended' );
		}
		if ( 'active' !== $session['status'] ) {
			return array( 'ok' => false, 'reason' => 'inactive' );
		}
		if ( false === ( $session['open'] ?? true ) ) {
			return array( 'ok' => false, 'reason' => 'closed' );
		}

		$max   = (int) ( $session['maxLength'] ?? QD_App::config( 'defaultMaxLength' ) );
		$clean = trim( preg_replace( '/\s+/u', ' ', $text ) );
		if ( mb_strlen( $clean ) < 5 ) {
			return array( 'ok' => false, 'reason' => 'tooShort' );
		}
		if ( mb_strlen( $clean ) > $max ) {
			return array( 'ok' => false, 'reason' => 'tooLong' );
		}

		$device_id = QD_Tokens::device_shape( $device_id ) ? $device_id : '';
		if ( ! $device_id || ! QD_Tokens::device_valid( $sid, $device_id ) ) {
			if ( ! QD_Tokens::valid_credential( $session, $credential ) ) {
				return array( 'ok' => false, 'reason' => 'expired' );
			}
		}
		$waiting = self::cooldown_remaining( $session, $device_id );
		if ( $waiting > 0 ) {
			return array( 'ok' => false, 'reason' => 'cooldown', 'waitSeconds' => $waiting );
		}
		if ( ! $skip_room_cap && ! self::room_budget_available( $sid ) ) {
			return array( 'ok' => false, 'reason' => 'busy' );
		}

		$started = QD_Util::now_ms();
		$id      = QD_Questions::insert( $sid, $device_id, $clean );
		if ( ! $id ) {
			return array( 'ok' => false, 'reason' => 'busy' );
		}
		if ( $device_id ) {
			// When the phone asked, not when its wait ends, so changing a session's wait
			// mid-event applies to phones already waiting.
			QD_Cache::set( 'cool_' . $sid . '_' . $device_id, QD_Util::now_ms(), (int) QD_App::config( 'cooldownCeiling' ) + 60 );
		}
		$answer = array( 'ok' => true, 'id' => $id, 'cooldownSeconds' => self::cooldown_for( $session ) );
		if ( $skip_room_cap ) {
			$answer['timing'] = array( 'saveMs' => QD_Util::now_ms() - $started );
		}
		return $answer;
	}

	public static function cooldown_for( $session ) {
		$value = $session['cooldownSeconds'] ?? null;
		return is_numeric( $value ) ? (int) $value : (int) QD_App::config( 'cooldownSeconds' );
	}

	/** Seconds this phone must still wait, from the session's setting as it is now. */
	public static function cooldown_remaining( $session, $device_id ) {
		if ( ! $device_id || ! $session ) {
			return 0;
		}
		$asked_at = (int) QD_Cache::get( 'cool_' . $session['id'] . '_' . $device_id );
		if ( ! $asked_at ) {
			return 0;
		}
		return max( 0, (int) ceil( ( $asked_at + self::cooldown_for( $session ) * 1000 - QD_Util::now_ms() ) / 1000 ) );
	}

	/**
	 * Per-session intake cap, so nothing identity-free can flood the queue. Approximate under
	 * a burst (the counter isn't locked): flood protection, not an exact quota.
	 */
	private static function room_budget_available( $sid ) {
		$bucket = 'room_' . $sid . '_' . floor( QD_Util::now_ms() / 60000 );
		if ( (int) QD_Cache::get( $bucket ) >= (int) QD_App::config( 'roomLimitPerMinute' ) ) {
			return false;
		}
		QD_Cache::bump( $bucket, 120 );
		return true;
	}

	// ------------------------------------------------------------ Me too

	/**
	 * The topics this phone can support, in every language the session shows. Only labels a
	 * facilitator approved — never anyone's question text — so nothing reaches the room
	 * unreviewed. Cached briefly: a full room polls this.
	 */
	public static function get_topics( $sid = '', $device_id = '' ) {
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		if ( ! QD_Tokens::device_valid( $sid, $device_id ) ) {
			return array( 'ok' => false, 'reason' => 'expired' );
		}
		$base  = QD_Topics::public_topics_cached( $session );
		$votes = QD_Topics::votes( $sid );
		$mine  = self::my_votes( $sid, $device_id );

		$topics = array();
		foreach ( $base['topics'] as $t ) {
			$topics[] = array(
				'topic'    => $t['topic'],
				'labels'   => $t['labels'],
				'count'    => $t['questions'] + ( $votes[ $t['topic'] ] ?? 0 ),
				'answered' => $t['answered'],
				'mine'     => in_array( $t['topic'], $mine, true ),
			);
		}
		usort( $topics, function ( $a, $b ) {
			return $b['count'] <=> $a['count'];
		} );

		return array(
			'ok'                => true,
			// This phone's own questions a facilitator marked answered, never anyone else's.
			'mineAnswered'      => $base['answeredByDevice'][ $device_id ] ?? array(),
			'status'            => $session['status'],
			'open'              => false !== ( $session['open'] ?? true ),
			'cooldownRemaining' => self::cooldown_remaining( $session, $device_id ),
			'nowAnswering'      => $base['nowAnswering'],
			'topics'            => $topics,
		);
	}

	/** Turns this device's Me too on a topic on or off. */
	public static function me_too( $sid = '', $device_id = '', $topic = '' ) {
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		if ( 'ended' === $session['status'] ) {
			return array( 'ok' => false, 'reason' => 'ended' );
		}
		if ( 'active' !== $session['status'] ) {
			return array( 'ok' => false, 'reason' => 'inactive' );
		}
		if ( false === ( $session['open'] ?? true ) ) {
			return array( 'ok' => false, 'reason' => 'closed' );
		}
		if ( ! QD_Tokens::device_valid( $sid, $device_id ) ) {
			return array( 'ok' => false, 'reason' => 'expired' );
		}
		$topic = (string) $topic;
		$known = false;
		foreach ( QD_Topics::public_topics_cached( $session )['topics'] as $t ) {
			if ( $t['topic'] === $topic ) {
				$known = true;
				break;
			}
		}
		if ( ! $known ) {
			return array( 'ok' => false, 'reason' => 'unknownTopic' );
		}
		// The same identity-free cap questions have: minting devices can't swamp the room.
		$bucket = 'metoo_' . $sid . '_' . floor( QD_Util::now_ms() / 60000 );
		if ( (int) QD_Cache::get( $bucket ) >= (int) QD_App::config( 'meTooLimitPerMinute' ) ) {
			return array( 'ok' => false, 'reason' => 'busy' );
		}
		QD_Cache::bump( $bucket, 120 );

		$mine  = self::my_votes( $sid, $device_id );
		$at    = array_search( $topic, $mine, true );
		$up    = false === $at;
		if ( $up ) {
			$mine[] = $topic;
		} else {
			unset( $mine[ $at ] );
		}
		$count = QD_Topics::change_vote( $sid, $topic, $up );
		QD_Cache::set( 'votes_' . $sid . '_' . $device_id, array_values( $mine ), (int) QD_App::config( 'deviceTokenSeconds' ) );
		return array( 'ok' => true, 'mine' => $up, 'votes' => $count );
	}

	private static function my_votes( $sid, $device_id ) {
		$mine = QD_Cache::get( 'votes_' . $sid . '_' . $device_id );
		return is_array( $mine ) ? $mine : array();
	}
}
