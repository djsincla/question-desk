<?php
/** People: who manages Question Desk, who runs a queue, and adding and removing them. */

class Test_QD_People extends WP_UnitTestCase {

	private $owner;

	public function set_up() {
		parent::set_up();
		update_option( 'admin_email', 'owner@example.org' );
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
	}

	public function test_roles_decide_who_manages_and_who_facilitates() {
		$admin = self::factory()->user->create( array( 'role' => 'qd_admin', 'user_email' => 'deskadmin@example.org' ) );
		$mod   = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );

		$this->assertContains( 'deskadmin@example.org', QD_People::admins() );
		$this->assertContains( 'owner@example.org', QD_People::admins() );
		$this->assertSame( array( 'mod@example.org' ), QD_People::moderators() );

		wp_set_current_user( $admin );
		$this->assertTrue( QD_People::is_admin() );
		wp_set_current_user( $mod );
		$this->assertFalse( QD_People::is_admin() );
		$this->assertTrue( current_user_can( 'qd_facilitate' ) );
	}

	public function test_adding_a_person_creates_an_account_when_there_is_none() {
		QD_People::add_person( 'moderator', 'New.Person@example.org' );
		$user = get_user_by( 'email', 'new.person@example.org' );
		$this->assertNotFalse( $user );
		$this->assertContains( 'qd_facilitator', $user->roles );

		QD_People::add_person( 'admin', 'new.person@example.org' );
		$user = get_user_by( 'email', 'new.person@example.org' );
		$this->assertContains( 'qd_admin', $user->roles, 'an existing account just gains the role' );

		$this->expectExceptionMessage( 'Not an email address' );
		QD_People::add_person( 'moderator', 'not-an-address' );
	}

	public function test_removing_a_facilitator_takes_them_out_of_sessions_and_events() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$eid = QD_Events::save( array( 'name' => 'Spring conference', 'moderators' => array( 'mod@example.org' ) ) )['savedEventId'];
		$sid = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'moderators' => array( 'mod@example.org' ), 'eventId' => $eid ), 'owner@example.org', false );

		QD_People::remove_person( 'moderator', 'mod@example.org' );
		QD_Store::reset_cache();
		$this->assertSame( array(), QD_Store::get_session( $sid )['moderators'] );
		$this->assertSame( array(), QD_Store::get_event( $eid )['moderators'] );
		$this->assertNotFalse( get_user_by( 'email', 'mod@example.org' ), 'the WordPress account stays' );
		$this->assertSame( array(), QD_People::moderators() );
	}

	public function test_site_administrators_and_yourself_cannot_be_removed() {
		try {
			QD_People::remove_person( 'admin', 'owner@example.org' );
			$this->fail( 'removed the site administrator' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'WordPress administrators', $e->getMessage() );
		}
		$me = self::factory()->user->create( array( 'role' => 'qd_admin', 'user_email' => 'me@example.org' ) );
		wp_set_current_user( $me );
		$this->expectExceptionMessage( 'You cannot remove yourself' );
		QD_People::remove_person( 'admin', 'me@example.org' );
	}

	public function test_a_facilitator_only_sees_their_own_sessions() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$mine   = QD_Sessions::save_as( array( 'name' => 'Mine', 'moderators' => array( 'mod@example.org' ) ), 'owner@example.org', false );
		$theirs = QD_Sessions::save_as( array( 'name' => 'Theirs' ), 'owner@example.org', false );
		$ids    = wp_list_pluck( QD_People::sessions_for( 'mod@example.org' ), 'id' );
		$this->assertSame( array( $mine ), $ids );
		$this->assertContains( $theirs, wp_list_pluck( QD_People::sessions_for( 'owner@example.org' ), 'id' ), 'an administrator sees them all' );
	}

	public function test_requiring_a_session_checks_the_facilitator() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$other = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'other@example.org' ) );
		$sid   = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'moderators' => array( 'mod@example.org' ) ), 'owner@example.org', false );
		wp_set_current_user( $other );
		$this->expectExceptionMessage( 'not a QA Facilitator for this session' );
		QD_People::require_session( $sid );
	}
}
