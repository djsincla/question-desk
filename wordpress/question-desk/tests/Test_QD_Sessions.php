<?php
/** Sessions: saving and its checks, order, links, ending, deleting, duplicating, archiving. */

class Test_QD_Sessions extends WP_UnitTestCase {

	private $admin;

	public function set_up() {
		parent::set_up();
		$this->admin = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->admin );
		QD_Store::reset_cache();
	}

	private function make( array $input = array() ) {
		return QD_Sessions::save_as( array_merge( array( 'name' => 'Morning panel' ), $input ), 'owner@example.org', false );
	}

	public function test_a_new_session_gets_keys_and_sensible_defaults() {
		$session = QD_Store::get_session( $this->make() );
		$this->assertSame( 'Morning panel', $session['name'] );
		$this->assertSame( 'room', $session['access'] );
		$this->assertSame( 'inactive', $session['status'] );
		$this->assertSame( QD_App::config( 'defaultMaxLength' ), $session['maxLength'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{8}$/', $session['id'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{16}$/', $session['linkKey'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{16}$/', $session['screenKey'] );
	}

	public function test_a_session_can_say_which_room_it_is_in() {
		$sid = $this->make( array( 'room' => '  Ballroom   A ' ) );
		$this->assertSame( 'Ballroom A', QD_Store::get_session( $sid )['room'], 'tidied like any other name' );
		// The queue is told, so it can show it beside the session name; participants are not.
		$this->assertSame( 'Ballroom A', QD_Moderation::get_board( $sid )['session']['room'] );
		$this->assertArrayNotHasKey( 'room', QD_Participants::get_session_state( $sid, '' ) );
		$this->make( array( 'id' => $sid, 'name' => 'Morning panel', 'room' => '' ) );
		$this->assertSame( '', QD_Store::get_session( $sid )['room'] );
	}

	public function test_saving_checks_the_input() {
		$bad = array(
			array( array( 'name' => '  ' ), 'Give the session a name.' ),
			array( array( 'maxLength' => 10 ), 'Question length must be' ),
			array( array( 'cooldownSeconds' => -5 ), 'Time between questions' ),
			array( array( 'brandAccent' => 'teal' ), 'accent color' ),
			array( array( 'scheduledStart' => 4000, 'scheduledEnd' => 3000 ), 'end must be after the start' ),
			array( array( 'scheduledEnd' => 1000 ), 'already passed' ),
			array( array( 'eventId' => 'deadbeef' ), 'no longer exists' ),
		);
		foreach ( $bad as $case ) {
			list( $input, $message ) = $case;
			try {
				$this->make( $input );
				$this->fail( 'saved ' . wp_json_encode( $input ) );
			} catch ( QD_Error $e ) {
				$this->assertStringContainsString( $message, $e->getMessage() );
			}
		}
	}

	public function test_only_known_facilitators_are_kept() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$session = QD_Store::get_session( $this->make( array( 'moderators' => array( 'MOD@example.org', 'stranger@example.org' ) ) ) );
		$this->assertSame( array( 'mod@example.org' ), $session['moderators'] );
	}

	public function test_an_edit_that_omits_the_event_keeps_it() {
		$eid = QD_Util::new_id( 8 );
		QD_Store::save_event( array( 'id' => $eid, 'name' => 'Spring conference', 'created' => 1 ) );
		$sid = $this->make( array( 'eventId' => $eid ) );
		$this->make( array( 'id' => $sid, 'name' => 'Morning panel', 'heading' => 'Ask us' ) );
		$this->assertSame( $eid, QD_Store::get_session( $sid )['eventId'] );
		$this->make( array( 'id' => $sid, 'name' => 'Morning panel', 'eventId' => '' ) );
		$this->assertArrayNotHasKey( 'eventId', QD_Store::get_session( $sid ) );
	}

	public function test_prepared_questions_are_replaced_and_checked() {
		$sid = $this->make( array( 'prepared' => "What is new?\n\n  How do we help?  " ) );
		$this->assertSame( array( 'What is new?', 'How do we help?' ), QD_Questions::prepared_for( $sid ) );
		$this->make( array( 'id' => $sid, 'name' => 'Morning panel', 'prepared' => array( 'Only this one?' ) ) );
		$this->assertSame( array( 'Only this one?' ), QD_Questions::prepared_for( $sid ) );
		$this->expectException( QD_Error::class );
		$this->make( array( 'id' => $sid, 'name' => 'Morning panel', 'prepared' => array( 'Hi' ) ) );
	}

	public function test_new_sessions_go_on_top_and_reorder_moves_them() {
		$first  = $this->make( array( 'name' => 'First' ) );
		$second = $this->make( array( 'name' => 'Second' ) );
		$this->assertSame( array( $second, $first ), wp_list_pluck( QD_Store::all_sessions(), 'id' ) );
		QD_Sessions::reorder_ids( array( $first, $second ) );
		QD_Store::reset_cache();
		$this->assertSame( array( $first, $second ), wp_list_pluck( QD_Store::all_sessions(), 'id' ) );
	}

	public function test_links_carry_the_room_screen_key_and_only_link_sessions_get_one() {
		$session = QD_Store::get_session( $this->make() );
		$links   = QD_Sessions::links( $session );
		$this->assertStringContainsString( '?view=present&s=' . $session['id'] . '&r=' . $session['screenKey'], $links['present'] );
		$this->assertStringEndsWith( '&layout=qr', $links['slide'] );
		$this->assertNull( $links['participant'] );

		$linked = QD_Store::get_session( $this->make( array( 'name' => 'By link', 'access' => 'link' ) ) );
		$this->assertStringContainsString( 'k=' . $linked['linkKey'], QD_Sessions::links( $linked )['participant'] );
		$this->assertTrue( QD_Sessions::screen_key_valid( $linked, $linked['screenKey'] ) );
		$this->assertFalse( QD_Sessions::screen_key_valid( $linked, 'guessed' ) );
	}

	public function test_an_old_session_without_a_screen_key_gets_one_when_links_are_made() {
		$sid = $this->make();
		QD_Store::update_session( $sid, function ( &$s ) {
			unset( $s['screenKey'] );
		} );
		$links = QD_Sessions::links( QD_Store::get_session( $sid ) );
		$key   = QD_Store::get_session( $sid )['screenKey'];
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{16}$/', $key );
		$this->assertStringContainsString( 'r=' . $key, $links['present'] );
	}

	public function test_regenerate_link_replaces_only_that_key() {
		$sid    = $this->make( array( 'access' => 'link' ) );
		$before = QD_Store::get_session( $sid );
		QD_Sessions::regenerate_link( $sid, 'screen' );
		$after = QD_Store::get_session( $sid );
		$this->assertNotSame( $before['screenKey'], $after['screenKey'] );
		$this->assertSame( $before['linkKey'], $after['linkKey'] );
		QD_Sessions::regenerate_link( $sid, 'participant' );
		$this->assertNotSame( $after['linkKey'], QD_Store::get_session( $sid )['linkKey'] );
	}

	public function test_activating_and_ending() {
		$sid = $this->make();
		QD_Sessions::set_active( $sid, true );
		$this->assertSame( 'active', QD_Store::get_session( $sid )['status'] );
		$this->assertNotEmpty( QD_Store::get_session( $sid )['started'] );

		try {
			QD_Sessions::end( $sid, 'morning  PANEL' );   // case and spacing forgiven
		} catch ( QD_Error $e ) {
			$this->fail( $e->getMessage() );
		}
		$ended = QD_Store::get_session( $sid );
		$this->assertSame( 'ended', $ended['status'] );
		$this->assertFalse( $ended['open'] );

		$this->expectExceptionMessage( 'This session has ended and cannot be reopened.' );
		QD_Sessions::set_active( $sid, true );
	}

	public function test_ending_and_deleting_need_the_name_typed_back() {
		$sid = $this->make();
		try {
			QD_Sessions::end( $sid, 'Morning' );
			$this->fail( 'ended without the name' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Type the session name', $e->getMessage() );
		}
		QD_Sessions::set_active( $sid, true );
		try {
			QD_Sessions::delete( $sid, 'Morning panel' );
			$this->fail( 'deleted an active session' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Deactivate or end', $e->getMessage() );
		}
		QD_Sessions::set_active( $sid, false );
		QD_Sessions::delete( $sid, 'Morning panel' );
		$this->assertNull( QD_Store::get_session( $sid ) );
	}

	public function test_deleting_takes_the_questions_with_it() {
		$sid = $this->make( array( 'prepared' => array( 'Kept until the session goes' ) ) );
		QD_Sessions::delete( $sid, 'Morning panel' );
		$this->assertSame( array(), QD_Questions::prepared_for( $sid ) );
	}

	public function test_duplicating_copies_the_settings_but_not_the_schedule_or_keys() {
		$eid = QD_Util::new_id( 8 );
		QD_Store::save_event( array( 'id' => $eid, 'name' => 'Spring conference', 'created' => 1 ) );
		$sid  = $this->make( array(
			'eventId'        => $eid,
			'heading'        => 'Ask the panel',
			'access'         => 'link',
			'maxLength'      => 240,
			'scheduledStart' => QD_Util::now_ms() + 86400000,
			'prepared'       => array( 'What is next for us?' ),
		) );
		$copy = QD_Store::get_session( QD_Sessions::duplicate_session( $sid, null, 'owner@example.org', false ) );
		$this->assertSame( 'Morning panel (copy)', $copy['name'] );
		$this->assertSame( 'Ask the panel', $copy['heading'] );
		$this->assertSame( 240, $copy['maxLength'] );
		$this->assertSame( $eid, $copy['eventId'] );
		$this->assertNull( $copy['scheduledStart'] );
		$this->assertNotSame( QD_Store::get_session( $sid )['linkKey'], $copy['linkKey'] );
		$this->assertSame( array( 'What is next for us?' ), QD_Questions::prepared_for( $copy['id'] ) );
	}

	public function test_archiving_and_restoring_an_ended_session() {
		$sid = $this->make();
		try {
			QD_Sessions::archive( $sid );
			$this->fail( 'archived a session that had not ended' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Only ended sessions', $e->getMessage() );
		}
		QD_Sessions::end( $sid, 'Morning panel' );
		QD_Sessions::archive( $sid );
		$this->assertNull( QD_Store::get_session( $sid ) );
		$archived = QD_Sessions::archived();
		$this->assertSame( $sid, $archived[0]['id'] );
		$this->assertSame( 'Morning panel', $archived[0]['name'] );

		QD_Sessions::restore( $sid );
		$this->assertSame( 'ended', QD_Store::get_session( $sid )['status'] );
		$this->assertSame( array(), QD_Sessions::archived() );
	}

	public function test_a_restored_session_leaves_an_event_that_is_gone() {
		$eid = QD_Util::new_id( 8 );
		QD_Store::save_event( array( 'id' => $eid, 'name' => 'Spring conference', 'created' => 1 ) );
		$sid = $this->make( array( 'eventId' => $eid ) );
		QD_Sessions::end( $sid, 'Morning panel' );
		QD_Sessions::archive( $sid );
		QD_Store::delete_event_row( $eid );
		QD_Sessions::restore( $sid );
		$this->assertArrayNotHasKey( 'eventId', QD_Store::get_session( $sid ) );
	}

	public function test_only_administrators_may_change_sessions() {
		$sid = $this->make();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) ) );
		$this->expectExceptionMessage( 'Only administrators can do that.' );
		QD_Sessions::set_active( $sid, true );
	}
}
