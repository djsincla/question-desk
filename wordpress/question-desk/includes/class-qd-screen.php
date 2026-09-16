<?php
/**
 * The room screen, the PowerPoint slide and the panelist view (getRoomScreen in moderation.js).
 *
 * These need no sign-in, by the owner's decision: whoever can show the screen in the room can
 * open the link. The link carries its own key instead (?r=…), separate from the session id that
 * every participant link and QR code holds, so a forwarded participant link can never become a
 * room screen showing live codes.
 */

defined( 'ABSPATH' ) || exit;

class QD_Screen {

	public static function init() {
		QD_Api::register( 'getRoomScreen', array( __CLASS__, 'get_room_screen' ), 'public' );
	}

	public static function get_room_screen( $sid = '', $layout = '', $key = '' ) {
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			throw new QD_Error( 'Session not found.' );
		}
		if ( ! QD_Sessions::screen_key_valid( $session, $key ) && ! QD_People::can_moderate( $session, QD_People::current_email() ) ) {
			throw new QD_Error( 'This room screen link is out of date. Copy the new one from the Admin page.' );
		}
		$brand = QD_Brand::for_session( $session );
		unset( $brand['logo'] );   // the logo arrives with the page; this poll stays small

		$screen = array(
			'status'            => (string) $session['status'],
			'open'              => false !== ( $session['open'] ?? true ),
			'theme'             => (string) ( $session['theme'] ?? 'dark' ),
			'heading'           => (string) ( $session['heading'] ?? '' ) ?: 'Questions for the panel',
			'brand'             => $brand,
			'nowAnswering'      => empty( $session['nowAnswering'] ) ? null : QD_Topics::now_answering( $session ),
			'url'               => null,
			'refreshInSeconds'  => 5,
			'version'           => QD_VERSION,   // a screen left open in a frame reloads when this changes
		);
		if ( 'active' !== $session['status'] ) {
			return $screen;
		}

		// The code on screen leads wherever that screen's own link leads: through the session's
		// guest page when it uses one, so a phone and the screen agree on the address.
		$where = 'qr' === $layout ? 'slide' : 'room';
		if ( 'link' === $session['access'] ) {
			$screen['url'] = QD_Sessions::guest_link( $session, 's=' . $sid . '&k=' . $session['linkKey'], $where );
		} else {
			$token                      = QD_Tokens::room_token( $sid );
			$screen['url']              = QD_Sessions::guest_link( $session, 's=' . $sid . '&t=' . $token['token'], $where );
			$screen['refreshInSeconds'] = min( 5, $token['expiresIn'] + 1 );
		}
		if ( ! empty( $session['roomQuestions'] ) ) {
			$screen['asked'] = self::room_question_list( $session );
		}
		return $screen;
	}

	/**
	 * What the room screen lists when a session turns that on: exactly what phones show, most
	 * Me too first, without the one being answered (that's in the banner). Nothing a facilitator
	 * hasn't reviewed reaches the big screen.
	 */
	public static function room_question_list( array $session ) {
		$votes = QD_Topics::votes( $session['id'] );
		$now   = (array) ( $session['nowAnswering'] ?? array() );
		$live  = ! empty( $now['question'] ) ? QD_Topics::single_key( $now['question'] ) : (string) ( $now['topic'] ?? '' );

		$list = array();
		foreach ( QD_Topics::public_topics_cached( $session )['topics'] as $t ) {
			if ( $t['topic'] === $live ) {
				continue;
			}
			$list[] = array( 'labels' => $t['labels'], 'count' => $t['questions'] + ( $votes[ $t['topic'] ] ?? 0 ) );
		}
		usort( $list, function ( $a, $b ) {
			return $b['count'] <=> $a['count'];
		} );
		return array_slice( $list, 0, (int) QD_App::config( 'roomQuestionsMax' ) );
	}
}
