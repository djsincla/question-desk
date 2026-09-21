<?php
/** Event Coordinators: the role, the event they are assigned to, and their portal. */

class Test_QD_Coordinator extends WP_UnitTestCase {

	private $owner;
	private $mod;
	private $coord;
	private $eid;
	private $one;
	private $two;

	public function set_up() {
		parent::set_up();
		update_option( 'admin_email', 'owner@example.org' );
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		$this->mod   = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$this->coord = self::factory()->user->create( array( 'role' => 'qd_coordinator', 'user_email' => 'coord@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();

		$this->eid = QD_Events::save( array( 'name' => 'Fall Conference', 'coordinators' => array( 'coord@example.org' ) ) )['savedEventId'];
		$this->one = QD_Sessions::save_as( array( 'name' => 'Keynote', 'room' => 'Ballroom A', 'eventId' => $this->eid,
			'moderators' => array( 'mod@example.org' ) ), 'owner@example.org', false );
		$this->two = QD_Sessions::save_as( array( 'name' => 'Workshop', 'room' => 'Room 201', 'eventId' => $this->eid ), 'owner@example.org', false );
	}

	/** A question as a grouping run leaves it. */
	private function ask( $sid, $text, $logistics, $status = 'new' ) {
		global $wpdb;
		$id = QD_Questions::insert( $sid, '', $text );
		$wpdb->update( QD_Install::table( 'questions' ),
			array( 'topic' => 'A topic', 'status' => $status, 'lang' => 'English', 'logistics' => $logistics ? 'yes' : '' ),
			array( 'id' => $id ) );
		QD_Cache::invalidate( $sid );
		return $id;
	}

	public function test_the_role_is_its_own_and_assigned_per_event() {
		$state = QD_Admin::state();
		$this->assertSame( array( 'coord@example.org' ), $state['coordinators'] );
		$this->assertNotContains( 'coord@example.org', $state['moderators'], 'not a QA Facilitator' );
		$this->assertSame( array( 'coord@example.org' ), QD_Store::get_event( $this->eid )['coordinators'] );

		// Only people holding the role can be named on an event.
		QD_Events::save( array( 'id' => $this->eid, 'name' => 'Fall Conference',
			'coordinators' => array( 'coord@example.org', 'mod@example.org' ) ) );
		$this->assertSame( array( 'coord@example.org' ), QD_Store::get_event( $this->eid )['coordinators'] );

		// An edit that doesn't mention them leaves them alone.
		QD_Events::save( array( 'id' => $this->eid, 'name' => 'Fall Conference' ) );
		$this->assertSame( array( 'coord@example.org' ), QD_Store::get_event( $this->eid )['coordinators'] );
	}

	public function test_removing_the_role_takes_them_off_every_event() {
		QD_People::remove_person( 'coordinator', 'coord@example.org' );
		QD_Store::reset_cache();
		$this->assertSame( array(), QD_Admin::state()['coordinators'] );
		$this->assertSame( array(), QD_Store::get_event( $this->eid )['coordinators'] );
		$this->assertNotFalse( get_user_by( 'email', 'coord@example.org' ), 'the account stays' );
		$this->assertTrue( in_array( 'Event Coordinator removed', wp_list_pluck( QD_Activity::get()['entries'], 'action' ), true ) );
	}

	public function test_the_portal_gathers_the_events_logistics_questions() {
		$parking = $this->ask( $this->one, 'Where is the parking for this building?', true );
		$this->ask( $this->one, 'What does the new funding mean for families?', false );
		$quiet = $this->ask( $this->two, 'Is there a quiet room for a break?', true );
		$this->ask( $this->two, 'A dismissed one about parking', true, 'dismissed' );

		wp_set_current_user( $this->coord );
		$board = QD_Coordinator::board( $this->eid );
		$this->assertSame( 'Fall Conference', $board['event']['name'] );
		$ids = wp_list_pluck( $board['questions'], 'id' );
		sort( $ids );
		$expected = array( $parking, $quiet );
		sort( $expected );
		$this->assertSame( $expected, $ids );
		$rooms = array();
		foreach ( $board['questions'] as $q ) {
			$rooms[ $q['id'] ] = $q['room'];
		}
		$this->assertSame( 'Ballroom A', $rooms[ $parking ], 'where to go' );
		$this->assertSame( 'Room 201', $rooms[ $quiet ] );
		$this->assertSame( 2, $board['waiting'] );
		$this->assertFalse( $board['isAdmin'] );
		$names = wp_list_pluck( $board['sessions'], 'name' );   // newest first, as everywhere else
		sort( $names );
		$this->assertSame( array( 'Keynote', 'Workshop' ), $names );
	}

	public function test_a_coordinator_ticks_one_off_and_the_queue_sees_it() {
		$parking = $this->ask( $this->one, 'Where is the parking?', true );
		wp_set_current_user( $this->coord );
		$after = QD_Coordinator::set_sorted( $this->eid, $parking, true );
		$this->assertSame( 0, $after['waiting'] );
		$this->assertTrue( $after['questions'][0]['sorted'] );

		// The facilitator sees the flag, and that it was dealt with.
		wp_set_current_user( $this->mod );
		$rows = QD_Moderation::get_board( $this->one )['topics'][0]['questions'];
		$this->assertTrue( $rows[0]['logistics'] );
		$this->assertTrue( $rows[0]['sorted'] );

		wp_set_current_user( $this->coord );
		$this->assertSame( 1, QD_Coordinator::set_sorted( $this->eid, $parking, false )['waiting'], 'and can be put back' );
		wp_set_current_user( $this->owner );
		$this->assertContains( 'Logistics question sorted', wp_list_pluck( QD_Activity::get()['entries'], 'action' ) );
	}

	public function test_a_portal_is_one_events_and_only_for_its_own_people() {
		$other   = self::factory()->user->create( array( 'role' => 'qd_coordinator', 'user_email' => 'other@example.org' ) );
		$otherId = QD_Events::save( array( 'name' => 'Spring Day', 'coordinators' => array( 'other@example.org' ) ) )['savedEventId'];
		$mine    = $this->ask( $this->one, 'Where is the parking?', true );

		wp_set_current_user( $this->coord );
		$this->assertSame( 1, count( QD_Coordinator::board( $this->eid )['questions'] ) );
		try {
			QD_Coordinator::board( $otherId );
			$this->fail( 'read another event\'s portal' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'not an Event Coordinator', $e->getMessage() );
		}
		wp_set_current_user( $other );
		try {
			QD_Coordinator::set_sorted( $otherId, $mine, true );
			$this->fail( 'sorted another event\'s question' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'no longer in this event', $e->getMessage() );
		}

		// A QA Facilitator is not a coordinator; an administrator can always look.
		wp_set_current_user( $this->mod );
		$this->expectExceptionMessage( 'not an Event Coordinator' );
		QD_Coordinator::board( $this->eid );
	}

	public function test_the_portal_functions_need_the_coordinate_capability() {
		do_action( 'rest_api_init' );
		$registered = QD_Api::registered();
		foreach ( array( 'getCoordinatorBoard', 'setLogisticsSorted', 'myEvents' ) as $fn ) {
			$this->assertArrayHasKey( $fn, $registered );
			$this->assertSame( 'coordinate', $registered[ $fn ][1] );
		}
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'subscriber', 'user_email' => 'nobody@example.org' ) ) );
		$answer = QD_Api::call( 'getCoordinatorBoard', array( $this->eid ) );
		$this->assertFalse( $answer['ok'] );
		$this->assertStringContainsString( 'Event Coordinator', $answer['error'] );
	}

	public function test_the_portal_page_renders_with_its_board() {
		$this->ask( $this->one, 'Where is the parking?', true );
		wp_set_current_user( $this->coord );
		$html = QD_Pages::render( 'Coordinator.html', 'Fall Conference — event logistics', array(
			'eid'   => $this->eid,
			'board' => QD_Coordinator::board( $this->eid ),
		), array( 'eventId' => $this->eid ) );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $html, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( $this->eid, $boot['eid'] );
		$this->assertSame( 1, count( $boot['board']['questions'] ) );
		$this->assertStringContainsString( 'function el(', $html, 'the shared script section' );
		$this->assertStringContainsString( 'setLogisticsSorted', $html );
	}

	public function test_a_coordinator_sees_only_their_own_events() {
		QD_Events::save( array( 'name' => 'Spring Day' ) );
		wp_set_current_user( $this->coord );
		$mine = QD_Coordinator::my_events();
		$this->assertSame( array( 'Fall Conference' ), wp_list_pluck( $mine, 'name' ) );
		$this->assertStringContainsString( 'view=coordinator&e=' . $this->eid, $mine[0]['url'] );
	}
}
