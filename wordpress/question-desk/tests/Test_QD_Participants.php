<?php
/** Joining a session, asking, the wait between questions and the room cap. */

class Test_QD_Participants extends WP_UnitTestCase {

	private $sid;

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Sessions::set_active( $this->sid, true );
		wp_set_current_user( 0 );   // everything below is an anonymous phone
	}

	private function join( $sid = null ) {
		$sid    = $sid ? $sid : $this->sid;
		$code   = QD_Tokens::room_token( $sid )['token'];
		$joined = QD_Participants::claim_device( $sid, $code );
		$this->assertTrue( $joined['ok'], wp_json_encode( $joined ) );
		return $joined['deviceId'];
	}

	public function test_a_room_code_joins_once_and_a_guess_does_not() {
		$device = $this->join();
		$this->assertMatchesRegularExpression( '/^[a-f0-9-]{36}$/', $device );
		$this->assertTrue( QD_Participants::get_session_state( $this->sid, $device )['deviceValid'] );

		$this->assertSame( 'expired', QD_Participants::claim_device( $this->sid, 'not-the-code' )['reason'] );
		$this->assertSame( 'notFound', QD_Participants::claim_device( 'ffffffff', 'x' )['reason'] );
		$this->assertFalse( QD_Participants::get_session_state( $this->sid, 'made-up-device' )['deviceValid'] );
	}

	public function test_room_codes_rotate_and_the_previous_one_survives_one_window() {
		$first = QD_Tokens::room_token( $this->sid );
		$this->assertSame( $first['token'], QD_Tokens::room_token( $this->sid )['token'], 'stable inside its window' );

		// Move the issue time back one window, as a room screen polling past a rotation would.
		$window = (int) QD_App::config( 'entryTokenSeconds' ) * 1000;
		$stored = json_decode( get_option( 'qd_token_' . $this->sid ), true );
		$stored['issued'] -= $window + 1000;
		update_option( 'qd_token_' . $this->sid, wp_json_encode( $stored ), false );

		$second = QD_Tokens::room_token( $this->sid );
		$this->assertNotSame( $first['token'], $second['token'] );
		$this->assertTrue( QD_Participants::claim_device( $this->sid, $first['token'] )['ok'], 'a scan mid-rotation still works' );
		$this->assertTrue( QD_Participants::claim_device( $this->sid, $second['token'] )['ok'] );
	}

	public function test_a_code_photographed_before_the_screen_closed_stays_dead() {
		$old    = QD_Tokens::room_token( $this->sid );
		$window = (int) QD_App::config( 'entryTokenSeconds' ) * 1000;
		$stored = json_decode( get_option( 'qd_token_' . $this->sid ), true );
		$stored['issued'] -= $window * 5;   // the screen was shut for a while
		update_option( 'qd_token_' . $this->sid, wp_json_encode( $stored ), false );

		$fresh = QD_Tokens::room_token( $this->sid );
		$this->assertNotSame( $old['token'], $fresh['token'] );
		$this->assertSame( 'expired', QD_Participants::claim_device( $this->sid, $old['token'] )['reason'] );
	}

	public function test_credentials_and_devices_do_not_cross_sessions() {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner2@example.org' ) ) );
		$other = QD_Sessions::save_as( array( 'name' => 'Afternoon panel' ), 'owner2@example.org', false );
		QD_Sessions::set_active( $other, true );
		wp_set_current_user( 0 );

		$code   = QD_Tokens::room_token( $this->sid )['token'];
		$device = $this->join();
		$this->assertSame( 'expired', QD_Participants::claim_device( $other, $code )['reason'] );
		$this->assertFalse( QD_Participants::get_session_state( $other, $device )['deviceValid'] );
	}

	public function test_a_link_session_joins_with_its_key_and_replacing_it_stops_new_joins() {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner3@example.org' ) ) );
		$sid = QD_Sessions::save_as( array( 'name' => 'By link', 'access' => 'link' ), 'owner3@example.org', false );
		QD_Sessions::set_active( $sid, true );
		$key = QD_Store::get_session( $sid )['linkKey'];
		wp_set_current_user( 0 );

		$joined = QD_Participants::claim_device( $sid, $key );
		$this->assertTrue( $joined['ok'] );

		wp_set_current_user( get_user_by( 'email', 'owner3@example.org' )->ID );
		QD_Sessions::regenerate_link( $sid, 'participant' );
		wp_set_current_user( 0 );
		$this->assertSame( 'expired', QD_Participants::claim_device( $sid, $key )['reason'] );
		$this->assertTrue( QD_Participants::get_session_state( $sid, $joined['deviceId'] )['deviceValid'], 'phones already in keep their token' );
	}

	public function test_asking_respects_the_session_status() {
		$device = $this->join();
		$asked  = QD_Participants::submit_question( $this->sid, $device, 'What is next for the program?', '' );
		$this->assertTrue( $asked['ok'] );
		$this->assertSame( 'What is next for the program?', QD_Questions::rows( $this->sid )[0]['text'] );

		wp_set_current_user( get_user_by( 'email', 'owner@example.org' )->ID );
		QD_Sessions::set_active( $this->sid, false );
		wp_set_current_user( 0 );
		$this->assertSame( 'inactive', QD_Participants::submit_question( $this->sid, $device, 'Is anyone there?', '' )['reason'] );

		wp_set_current_user( get_user_by( 'email', 'owner@example.org' )->ID );
		QD_Sessions::end( $this->sid, 'Morning panel' );
		wp_set_current_user( 0 );
		$this->assertSame( 'ended', QD_Participants::submit_question( $this->sid, $device, 'Is anyone there?', '' )['reason'] );
		$this->assertSame( 'notFound', QD_Participants::submit_question( 'ffffffff', $device, 'Is anyone there?', '' )['reason'] );
	}

	public function test_question_length_and_oversized_payloads() {
		$device = $this->join();
		$this->assertSame( 'tooShort', QD_Participants::submit_question( $this->sid, $device, 'Hi', '' )['reason'] );
		$long = str_repeat( 'a', (int) QD_App::config( 'defaultMaxLength' ) + 1 );
		$this->assertSame( 'tooLong', QD_Participants::submit_question( $this->sid, $device, $long, '' )['reason'] );
		$huge = str_repeat( 'a', (int) QD_App::config( 'maxLengthCeiling' ) * 2 + 1 );
		$this->assertSame( 'tooLong', QD_Participants::submit_question( $this->sid, $device, $huge, '' )['reason'] );
		$this->assertSame( 'tooLong', QD_Participants::submit_question( $this->sid, $device, array( 'not' => 'a string' ), '' )['reason'] );
		$this->assertSame( array(), QD_Questions::rows( $this->sid ) );
	}

	public function test_whitespace_is_collapsed_before_the_length_check() {
		$device = $this->join();
		QD_Participants::submit_question( $this->sid, $device, "  What   is\n\n next?  ", '' );
		$this->assertSame( 'What is next?', QD_Questions::rows( $this->sid )[0]['text'] );
	}

	public function test_a_phone_without_a_device_token_needs_the_code() {
		$this->assertSame( 'expired', QD_Participants::submit_question( $this->sid, '', 'Can I ask without joining?', '' )['reason'] );
		$code = QD_Tokens::room_token( $this->sid )['token'];
		$this->assertTrue( QD_Participants::submit_question( $this->sid, '', 'Can I ask with the code?', $code )['ok'], 'a lapsed token re-joins from the link' );
		$this->assertSame( 'unknown', QD_Questions::rows( $this->sid )[0]['device'], 'a malformed device id is never stored' );
	}

	public function test_the_wait_between_questions_counts_down_and_is_per_session() {
		$device = $this->join();
		QD_Participants::submit_question( $this->sid, $device, 'The first question of the day', '' );
		$again = QD_Participants::submit_question( $this->sid, $device, 'And a second one straight after', '' );
		$this->assertSame( 'cooldown', $again['reason'] );
		$this->assertGreaterThan( 0, $again['waitSeconds'] );
		$this->assertLessThanOrEqual( (int) QD_App::config( 'cooldownSeconds' ), $again['waitSeconds'] );
		$this->assertSame( $again['waitSeconds'], QD_Participants::get_session_state( $this->sid, $device )['cooldownRemaining'] );
		$this->assertSame( 1, count( QD_Questions::rows( $this->sid ) ) );
	}

	public function test_changing_the_wait_applies_to_phones_already_waiting() {
		$device = $this->join();
		QD_Participants::submit_question( $this->sid, $device, 'The first question of the day', '' );
		$this->assertGreaterThan( 0, QD_Participants::get_session_state( $this->sid, $device )['cooldownRemaining'] );

		wp_set_current_user( get_user_by( 'email', 'owner@example.org' )->ID );
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'cooldownSeconds' => 0 ), 'owner@example.org', false );
		wp_set_current_user( 0 );

		$state = QD_Participants::get_session_state( $this->sid, $device );
		$this->assertSame( 0, $state['cooldownRemaining'] );
		$this->assertSame( 0, $state['cooldownSeconds'] );
		$this->assertTrue( QD_Participants::submit_question( $this->sid, $device, 'Straight on to the next one', '' )['ok'] );
	}

	public function test_the_room_cap_is_per_session_and_per_minute() {
		$cap = (int) QD_App::config( 'roomLimitPerMinute' );
		QD_Cache::set( 'room_' . $this->sid . '_' . floor( QD_Util::now_ms() / 60000 ), $cap, 120 );
		$device = $this->join();
		$this->assertSame( 'busy', QD_Participants::submit_question( $this->sid, $device, 'One more for the panel', '' )['reason'] );

		wp_set_current_user( get_user_by( 'email', 'owner@example.org' )->ID );
		$other = QD_Sessions::save_as( array( 'name' => 'Afternoon panel' ), 'owner@example.org', false );
		QD_Sessions::set_active( $other, true );
		wp_set_current_user( 0 );
		$this->assertTrue( QD_Participants::submit_question( $other, $this->join( $other ), 'The other room is fine', '' )['ok'] );
	}

	public function test_a_hundred_phones_asking_at_once_all_land() {
		$wanted = 100;
		for ( $i = 0; $i < $wanted; $i++ ) {
			$answer = QD_Participants::submit_question( $this->sid, $this->join(), 'Question number ' . $i . ' for the panel', '' );
			$this->assertTrue( $answer['ok'], wp_json_encode( $answer ) );
		}
		$this->assertSame( $wanted, count( QD_Questions::rows( $this->sid ) ) );
		$this->assertSame( $wanted, count( array_unique( wp_list_pluck( QD_Questions::rows( $this->sid ), 'id' ) ) ) );
	}

	public function test_the_participant_page_gets_its_session_and_credential() {
		$html = QD_Pages::render( 'Ask.html', 'Ask a question', array(
			'sid'        => $this->sid,
			'credential' => 'abc123',
			'languages'  => QD_Settings::language_list( QD_Store::get_session( $this->sid ) ),
		), QD_Store::get_session( $this->sid ) );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $html, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( $this->sid, $boot['sid'] );
		$this->assertSame( 'abc123', $boot['credential'] );
		$this->assertSame( 'en', $boot['languages'][0]['code'] );
		$this->assertArrayHasKey( 'ko', $boot['text'] );
	}
}
