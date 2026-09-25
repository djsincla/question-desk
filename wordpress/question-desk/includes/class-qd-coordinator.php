<?php
/**
 * The Event Coordinator portal (coordinator.js in the Apps Script version).
 *
 * Questions about running the event — parking, rooms, timing, interpretation — are picked out
 * as Gemini groups them. They stay in the session's queue, where a facilitator can still answer
 * them from the stage, and they also gather here, for the people who can do something about them.
 */

defined( 'ABSPATH' ) || exit;

class QD_Coordinator {

	public static function init() {
		QD_Api::register( 'getCoordinatorBoard', array( __CLASS__, 'board' ), 'coordinate' );
		QD_Api::register( 'setLogisticsSorted', array( __CLASS__, 'set_sorted' ), 'coordinate' );
		QD_Api::register( 'myEvents', array( __CLASS__, 'my_events' ), 'coordinate' );
	}

	/** Everything one event's coordinators see: their logistics questions, newest first. */
	public static function board( $eid = '' ) {
		$event    = QD_People::require_event( $eid );
		$sessions = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) === $eid && empty( $s['loadTest'] ) ) {
				$sessions[] = $s;
			}
		}

		$questions = array();
		foreach ( $sessions as $s ) {
			foreach ( QD_Questions::rows( $s['id'] ) as $q ) {
				if ( ! $q['logistics'] || 'dismissed' === $q['status'] ) {
					continue;
				}
				$questions[] = array(
					'id'          => $q['id'],
					'session'     => (string) $s['name'],
					'room'        => (string) ( $s['room'] ?? '' ),
					'sessionId'   => $s['id'],
					'text'        => $q['text'],
					'translation' => $q['translation'],
					'lang'        => $q['lang'],
					'submitted'   => $q['submitted'],
					'answered'    => 'answered' === $q['status'],
					'sorted'      => $q['sorted'],
				);
			}
		}
		usort( $questions, function ( $a, $b ) {
			return ( (int) $a['sorted'] <=> (int) $b['sorted'] )
				?: ( ( $b['submitted'] <=> $a['submitted'] ) ?: strcmp( $a['id'], $b['id'] ) );
		} );

		$waiting = 0;
		foreach ( $questions as $q ) {
			$waiting += $q['sorted'] ? 0 : 1;
		}
		return array(
			'event'            => array( 'id' => $event['id'], 'name' => $event['name'] ),
			'isAdmin'          => current_user_can( 'qd_manage' ),
			'adminUrl'         => current_user_can( 'qd_manage' ) ? admin_url( 'admin.php?page=' . QD_Admin::MENU_SLUG ) : '',
			'coordinators'     => QD_People::coordinators_for( $event ),
			'sessions'         => array_map( function ( $s ) {
				return array( 'id' => $s['id'], 'name' => $s['name'], 'room' => (string) ( $s['room'] ?? '' ), 'status' => $s['status'] );
			}, $sessions ),
			'questions'        => $questions,
			'waiting'          => $waiting,
			'refreshInSeconds' => 15,
		);
	}

	/** A coordinator ticks one off, or puts it back. */
	public static function set_sorted( $eid = '', $question_id = '', $sorted = true ) {
		global $wpdb;
		$event = QD_People::require_event( $eid );
		$ids   = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) === $eid ) {
				$ids[] = $s['id'];
			}
		}
		$question = $ids ? QD_Questions::get( $question_id ) : null;
		if ( ! $question || ! in_array( $question['sessionId'], $ids, true ) || ! $question['logistics'] ) {
			throw new QD_Error( 'That question is no longer in this event.' );
		}
		$wpdb->update( QD_Install::table( 'questions' ), array( 'logistics' => $sorted ? 'sorted' : 'yes' ), array( 'id' => $question['id'] ) );
		QD_Cache::invalidate( $question['sessionId'] );
		QD_Activity::log( $sorted ? 'Logistics question sorted' : 'Logistics question reopened',
			array( 'id' => $event['id'], 'eventName' => $event['name'] ),
			'"' . mb_substr( $question['text'], 0, 120 ) . '"' );
		return self::board( $eid );
	}

	/** The events this coordinator can open, for the picker and for staff links. */
	public static function my_events() {
		$email = QD_People::current_email();
		if ( ! $email ) {
			return array();
		}
		$out = array();
		foreach ( QD_People::events_for( $email ) as $ev ) {
			$out[] = array( 'id' => $ev['id'], 'name' => $ev['name'], 'url' => self::link( $ev ) );
		}
		return $out;
	}

	public static function link( array $event ) {
		return QD_Router::base_url() . '?view=coordinator&e=' . $event['id'];
	}
}
