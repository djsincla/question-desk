<?php
/** The room screen, the slide and the panelist view: what they show and who may open them. */

class Test_QD_Screen extends WP_UnitTestCase {

	private $sid;
	private $owner;

	public function set_up() {
		parent::set_up();
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'heading' => 'Ask the panel' ), 'owner@example.org', false );
		QD_Sessions::set_active( $this->sid, true );
	}

	private function key() {
		return QD_Store::get_session( $this->sid )['screenKey'];
	}

	public function test_the_screen_shows_a_joining_link_that_rotates_with_the_room_code() {
		wp_set_current_user( 0 );   // a screen in the room is signed into nothing
		$screen = QD_Screen::get_room_screen( $this->sid, 'full', $this->key() );
		$this->assertSame( 'active', $screen['status'] );
		$this->assertSame( 'Ask the panel', $screen['heading'] );
		$this->assertStringContainsString( '?s=' . $this->sid . '&t=', $screen['url'] );
		$this->assertLessThanOrEqual( 5, $screen['refreshInSeconds'] );
		$this->assertSame( QD_VERSION, $screen['version'] );
		$this->assertArrayNotHasKey( 'logo', $screen['brand'], 'the logo comes with the page, not every poll' );

		$code = QD_Tokens::room_token( $this->sid )['token'];
		$this->assertStringContainsString( '&t=' . $code, $screen['url'] );
		$this->assertTrue( QD_Participants::claim_device( $this->sid, $code )['ok'], 'the code on screen joins' );
	}

	public function test_a_link_session_shows_its_shareable_link_instead() {
		$sid = QD_Sessions::save_as( array( 'name' => 'By link', 'access' => 'link' ), 'owner@example.org', false );
		QD_Sessions::set_active( $sid, true );
		$session = QD_Store::get_session( $sid );
		wp_set_current_user( 0 );
		$screen = QD_Screen::get_room_screen( $sid, 'full', $session['screenKey'] );
		$this->assertStringContainsString( '?s=' . $sid . '&k=' . $session['linkKey'], $screen['url'] );
		$this->assertSame( 5, $screen['refreshInSeconds'] );
	}

	public function test_an_inactive_session_shows_no_joining_link() {
		QD_Sessions::set_active( $this->sid, false );
		wp_set_current_user( 0 );
		$screen = QD_Screen::get_room_screen( $this->sid, 'full', $this->key() );
		$this->assertNull( $screen['url'] );
		$this->assertSame( 'inactive', $screen['status'] );
	}

	public function test_the_screen_link_needs_its_own_key_or_a_facilitator() {
		$key = $this->key();
		wp_set_current_user( 0 );
		try {
			QD_Screen::get_room_screen( $this->sid, 'full', 'guessed' );
			$this->fail( 'opened the room screen without the key' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'out of date', $e->getMessage() );
		}
		// A participant link carries the session id but never the key, so it can't become a screen.
		wp_set_current_user( $this->owner );
		$this->assertIsArray( QD_Screen::get_room_screen( $this->sid, 'full', '' ), 'a facilitator needs no key' );

		wp_set_current_user( $this->owner );
		QD_Sessions::regenerate_link( $this->sid, 'screen' );
		wp_set_current_user( 0 );
		$this->expectExceptionMessage( 'out of date' );
		QD_Screen::get_room_screen( $this->sid, 'full', $key );
	}

	public function test_the_room_list_shows_only_reviewed_wording_most_asked_first() {
		global $wpdb;
		$make = function ( $text, $topic, $votes ) use ( $wpdb ) {
			$id = QD_Questions::insert( $this->sid, '', $text );
			$wpdb->update( QD_Install::table( 'questions' ), array( 'topic' => $topic ), array( 'id' => $id ) );
			QD_Topics::save( $this->sid, $topic, array( 'shown' => 1 ) );
			for ( $i = 0; $i < $votes; $i++ ) {
				QD_Topics::change_vote( $this->sid, $topic, true );
			}
			return $id;
		};
		$make( 'Will there be a waiting list?', 'Waiting lists', 1 );
		$make( 'Where do we park for the event?', 'Parking', 5 );
		QD_Topics::save( $this->sid, 'Not approved', array( 'shown' => 0 ) );
		$hidden = QD_Questions::insert( $this->sid, '', 'A question nobody has reviewed yet' );
		$wpdb->update( QD_Install::table( 'questions' ), array( 'topic' => 'Not approved' ), array( 'id' => $hidden ) );

		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'roomQuestions' => true ), 'owner@example.org', false );
		wp_set_current_user( 0 );
		$screen = QD_Screen::get_room_screen( $this->sid, 'full', $this->key() );
		$this->assertSame( array( 'Parking', 'Waiting lists' ), array_column( wp_list_pluck( $screen['asked'], 'labels' ), 'en' ) );
		$this->assertSame( 6, $screen['asked'][0]['count'], 'one question plus five Me toos' );
		$this->assertStringNotContainsString( 'nobody has reviewed', wp_json_encode( $screen ) );
	}

	public function test_the_room_list_leaves_out_what_is_being_answered() {
		global $wpdb;
		foreach ( array( 'Waiting lists', 'Parking' ) as $topic ) {
			$id = QD_Questions::insert( $this->sid, '', 'A question about ' . $topic );
			$wpdb->update( QD_Install::table( 'questions' ), array( 'topic' => $topic ), array( 'id' => $id ) );
			QD_Topics::save( $this->sid, $topic, array( 'shown' => 1 ) );
		}
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'roomQuestions' => true ), 'owner@example.org', false );
		QD_Store::update_session( $this->sid, function ( &$s ) {
			$s['nowAnswering'] = array( 'topic' => 'Parking', 'at' => QD_Util::now_ms() );
		} );
		QD_Cache::invalidate( $this->sid );

		wp_set_current_user( 0 );
		$screen = QD_Screen::get_room_screen( $this->sid, 'full', $this->key() );
		$this->assertSame( array( 'Waiting lists' ), array_column( wp_list_pluck( $screen['asked'], 'labels' ), 'en' ) );
		$this->assertSame( 'Parking', $screen['nowAnswering']['topic'] );
	}

	public function test_a_session_without_the_option_lists_nothing() {
		wp_set_current_user( 0 );
		$this->assertArrayNotHasKey( 'asked', QD_Screen::get_room_screen( $this->sid, 'full', $this->key() ) );
	}

	public function test_the_pages_render_with_what_they_need() {
		$session = QD_Store::get_session( $this->sid );
		$room    = QD_Pages::render( 'Present.html', $session['name'], array(
			'sid' => $this->sid, 'key' => $this->key(), 'theme' => 'dark', 'layout' => 'qr',
			'languages' => QD_Settings::languages_for( $session ), 'version' => QD_VERSION,
		), $session );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $room, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( 'qr', $boot['layout'] );
		$this->assertSame( $this->key(), $boot['key'] );
		$this->assertStringContainsString( 'function qrArt(', $room, 'the QR drawing from Scripts.html' );

		$panel = QD_Pages::render( 'Panel.html', $session['name'] . ' — panel', array(
			'sid' => $this->sid, 'key' => $this->key(), 'theme' => 'dark', 'version' => QD_VERSION,
		), $session );
		$this->assertStringContainsString( 'getRoomScreen', $panel );
	}

	public function test_the_screen_is_one_of_the_pages_other_sites_may_frame() {
		$this->assertContains( 'Present.html', QD_Pages::FRAMABLE, 'the PowerPoint add-in frames the slide' );
		$this->assertContains( 'Panel.html', QD_Pages::FRAMABLE );
		$this->assertNotContains( 'Admin.html', QD_Pages::FRAMABLE );
		$this->assertNotContains( 'Moderate.html', QD_Pages::FRAMABLE );
	}

	public function test_the_qr_sheet_lists_an_events_shareable_link_sessions() {
		$eid = QD_Events::save( array( 'name' => 'Spring conference' ) )['savedEventId'];
		$one = QD_Sessions::save_as( array( 'name' => 'By link', 'access' => 'link', 'eventId' => $eid ), 'owner@example.org', false );
		QD_Sessions::save_as( array( 'name' => 'In the room', 'eventId' => $eid ), 'owner@example.org', false );
		$ended = QD_Sessions::save_as( array( 'name' => 'Done already', 'access' => 'link', 'eventId' => $eid ), 'owner@example.org', false );
		QD_Sessions::end( $ended, 'Done already' );

		$sessions = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) !== $eid || 'ended' === $s['status'] ) {
				continue;
			}
			$sessions[] = array( 'name' => $s['name'], 'url' => 'link' === $s['access'] ? QD_Sessions::links( $s )['participant'] : '' );
		}
		$html = QD_Pages::render( 'Sheet.html', 'Spring conference — QR sheets', array(
			'eventName' => 'Spring conference',
			'languages' => QD_Settings::site_languages(),
			'sessions'  => $sessions,
		), array( 'eventId' => $eid ) );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $html, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( array( 'In the room', 'By link' ), wp_list_pluck( $boot['sessions'], 'name' ), 'ended sessions stay off the sheet' );
		$this->assertStringContainsString( 'k=' . QD_Store::get_session( $one )['linkKey'], $boot['sessions'][1]['url'] );
		$this->assertSame( '', $boot['sessions'][0]['url'], 'a room session has no shareable link' );
	}
}
