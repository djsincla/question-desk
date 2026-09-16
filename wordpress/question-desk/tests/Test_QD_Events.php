<?php
/** Events: saving, branding and languages cascading to sessions, deleting, duplicating. */

class Test_QD_Events extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
	}

	private function event( array $input = array() ) {
		$state = QD_Events::save( array_merge( array( 'name' => 'Spring conference' ), $input ) );
		return $state['savedEventId'];
	}

	private function session( array $input = array() ) {
		return QD_Sessions::save_as( array_merge( array( 'name' => 'Morning panel' ), $input ), 'owner@example.org', false );
	}

	public function test_saving_an_event_and_editing_it() {
		$eid = $this->event( array( 'orgName' => 'Autism Society', 'accent' => '#1B5E5A' ) );
		$ev  = QD_Store::get_event( $eid );
		$this->assertSame( 'Spring conference', $ev['name'] );
		$this->assertSame( '#1b5e5a', $ev['brand']['accent'] );

		$this->event( array( 'id' => $eid, 'name' => 'Spring conference 2027' ) );
		$this->assertSame( 'Spring conference 2027', QD_Store::get_event( $eid )['name'] );

		try {
			$this->event( array( 'name' => 'Bad color', 'accent' => 'teal' ) );
			$this->fail( 'saved a bad color' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'must be a color', $e->getMessage() );
		}
		$this->expectExceptionMessage( 'Give the event a name.' );
		$this->event( array( 'name' => ' ' ) );
	}

	public function test_branding_goes_site_then_event_then_session() {
		QD_Settings::save_brand( array( 'orgName' => 'Autism Society', 'accent' => '#111111', 'footer' => 'See you next time' ) );
		$eid = $this->event( array( 'orgName' => 'Spring conference', 'accent' => '#222222' ) );
		$sid = $this->session( array( 'eventId' => $eid, 'brandAccent' => '#333333' ) );

		$this->assertSame( '#111111', QD_Brand::site()['accent'] );
		$brand = QD_Brand::for_session( QD_Store::get_session( $sid ) );
		$this->assertSame( '#333333', $brand['accent'], 'the session wins' );
		$this->assertSame( 'Spring conference', $brand['orgName'], 'from the event' );
		$this->assertSame( 'See you next time', $brand['footer'], 'from the site' );
		$this->assertSame( 'Spring conference', $brand['eventName'] );
	}

	public function test_languages_come_from_the_event_or_the_site() {
		QD_Settings::save_site_languages( array( 'es' ) );
		$this->assertSame( array( 'en', 'es' ), QD_Settings::site_languages() );

		$eid = $this->event( array( 'languages' => array( 'ko' ) ) );
		$sid = $this->session( array( 'eventId' => $eid ) );
		$this->assertSame( array( 'en', 'ko' ), QD_Settings::languages_for( QD_Store::get_session( $sid ) ) );

		$this->event( array( 'id' => $eid, 'name' => 'Spring conference', 'languages' => array() ) );
		QD_Store::reset_cache();
		$this->assertSame( array( 'en', 'es' ), QD_Settings::languages_for( QD_Store::get_session( $sid ) ), 'no event choice falls back to the site' );

		$this->expectExceptionMessage( 'Unknown language' );
		QD_Settings::save_site_languages( array( 'klingon' ) );
	}

	public function test_a_sessions_facilitators_include_the_events() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'lead@example.org' ) );
		$eid = $this->event( array( 'moderators' => array( 'lead@example.org' ) ) );
		$sid = $this->session( array( 'eventId' => $eid, 'moderators' => array( 'mod@example.org' ) ) );
		$session = QD_Store::get_session( $sid );
		$this->assertSame( array( 'mod@example.org', 'lead@example.org' ), QD_People::facilitators_for( $session ) );
		$this->assertTrue( QD_People::can_moderate( $session, 'lead@example.org' ) );
		$this->assertFalse( QD_People::can_moderate( $session, 'stranger@example.org' ) );
	}

	public function test_deleting_an_event_keeps_its_sessions() {
		$eid = $this->event();
		$sid = $this->session( array( 'eventId' => $eid ) );
		try {
			QD_Events::delete( $eid, 'Spring' );
			$this->fail( 'deleted without the name' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Type the event name', $e->getMessage() );
		}
		QD_Events::delete( $eid, 'spring CONFERENCE' );
		$this->assertNull( QD_Store::get_event( $eid ) );
		$this->assertNotNull( QD_Store::get_session( $sid ) );
		$this->assertArrayNotHasKey( 'eventId', QD_Store::get_session( $sid ) );
	}

	public function test_duplicating_an_event_copies_its_sessions_with_their_names() {
		$eid = $this->event( array( 'orgName' => 'Spring conference' ) );
		$this->session( array( 'name' => 'Morning panel', 'eventId' => $eid ) );
		$this->session( array( 'name' => 'Afternoon panel', 'eventId' => $eid ) );
		$state = QD_Events::duplicate( $eid );
		$copy  = $state['savedEventId'];
		$this->assertSame( 'Spring conference (copy)', QD_Store::get_event( $copy )['name'] );
		$names = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) === $copy ) {
				$names[] = $s['name'];
			}
		}
		sort( $names );
		$this->assertSame( array( 'Afternoon panel', 'Morning panel' ), $names );
	}

	public function test_new_events_go_on_top_and_reorder_moves_them() {
		$first  = $this->event( array( 'name' => 'First' ) );
		$second = $this->event( array( 'name' => 'Second' ) );
		$this->assertSame( array( $second, $first ), wp_list_pluck( QD_Store::all_events(), 'id' ) );
		QD_Events::reorder( array( $first, $second ) );
		QD_Store::reset_cache();
		$this->assertSame( array( $first, $second ), wp_list_pluck( QD_Store::all_events(), 'id' ) );
	}
}
