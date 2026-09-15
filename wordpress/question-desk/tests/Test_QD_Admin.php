<?php
/** The Admin page's state, what the page may call, and the activity log behind it. */

class Test_QD_Admin extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		update_option( 'admin_email', 'owner@example.org' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
	}

	public function test_state_has_everything_the_page_draws() {
		$sid   = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'prepared' => array( 'What is next for us?' ) ), 'owner@example.org', false );
		$state = QD_Admin::state();

		foreach ( array( 'me', 'owner', 'admins', 'moderators', 'sessions', 'events', 'languages', 'siteLanguages',
			'maxLanguages', 'archived', 'brand', 'summaryDefaults', 'appUrl', 'ops', 'gemini', 'geminiDefaults',
			'storage', 'health', 'limits', 'app' ) as $key ) {
			$this->assertArrayHasKey( $key, $state, $key . ' is missing' );
		}
		$this->assertSame( 'owner@example.org', $state['me'] );
		$this->assertSame( QD_Router::base_url(), $state['appUrl'] );
		$session = $state['sessions'][0];
		$this->assertSame( $sid, $session['id'] );
		$this->assertSame( 0, $session['questionCount'] );
		$this->assertSame( array( 'What is next for us?' ), $session['prepared'] );
		$this->assertStringContainsString( 'view=moderate', $session['links']['moderate'] );
		$this->assertSame( array( 'room' => false, 'slide' => false, 'panel' => false, 'url' => '' ), $session['guestPage'] );
		$this->assertNotEmpty( $state['languages'][0]['native'] );
	}

	public function test_summary_recipients_are_the_people_tab_list_only() {
		$sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Settings::save_summary_defaults( array( 'extra' => 'reports@example.org, board@example.org' ) );
		$state = QD_Admin::state();
		$this->assertSame( array( 'reports@example.org', 'board@example.org' ), $state['sessions'][0]['summaryTo'] );
		$this->assertFalse( $state['summaryDefaults']['facilitators'] );
		unset( $sid );
	}

	public function test_only_administrators_get_the_state() {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) ) );
		$this->expectExceptionMessage( 'Only administrators can do that.' );
		QD_Admin::state();
	}

	public function test_the_page_can_call_the_phase_one_functions() {
		do_action( 'rest_api_init' );
		$registered = QD_Api::registered();
		foreach ( array( 'adminState', 'saveSession', 'setSessionActive', 'endSession', 'deleteSession', 'reorderSessions',
			'duplicateSession', 'archiveSession', 'restoreSession', 'regenerateLink', 'saveEvent', 'deleteEvent',
			'reorderEvents', 'duplicateEvent', 'saveBrand', 'saveSiteLanguages', 'saveSummaryDefaults', 'addPerson',
			'removePerson', 'saveLogo', 'removeLogo', 'getSessionLogo', 'saveEventLogo', 'removeEventLogo', 'getEventLogo' ) as $fn ) {
			$this->assertArrayHasKey( $fn, $registered, $fn . ' is not registered' );
			$this->assertSame( 'manage', $registered[ $fn ][1], $fn . ' must need qd_manage' );
		}
		$answer = QD_Api::call( 'adminState', array() );
		$this->assertTrue( $answer['ok'] );
		$this->assertSame( 'owner@example.org', $answer['value']['me'] );
	}

	public function test_later_phases_say_so_instead_of_failing_silently() {
		$answer = QD_Api::call( 'getActivity', array( array() ) );
		$this->assertFalse( $answer['ok'] );
		$this->assertStringContainsString( 'not in the WordPress version yet', $answer['error'] );
	}

	public function test_the_admin_page_is_in_the_menu_for_administrators_only() {
		global $submenu;
		do_action( 'admin_menu' );
		$this->assertTrue( current_user_can( 'qd_manage' ) );
		unset( $submenu );

		$found = false;
		foreach ( $GLOBALS['menu'] ?? array() as $item ) {
			if ( QD_Admin::MENU_SLUG === ( $item[2] ?? '' ) ) {
				$found = true;
				$this->assertSame( 'qd_manage', $item[1] );
			}
		}
		$this->assertTrue( $found, 'the Question Desk menu was not added' );
	}

	public function test_every_staff_action_is_written_to_the_activity_log() {
		$sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Sessions::set_active( $sid, true );
		QD_Settings::save_brand( array( 'orgName' => 'Autism Society' ) );

		$log     = QD_Activity::get( array( 'limit' => 20 ) );
		$actions = wp_list_pluck( $log['entries'], 'action' );
		$this->assertContains( 'Session created', $actions );
		$this->assertContains( 'Session activated', $actions );
		$this->assertContains( 'Branding saved', $actions );
		$this->assertSame( 'owner@example.org', $log['entries'][0]['who'] );

		$only = QD_Activity::get( array( 'target' => $sid ) );
		$this->assertSame( array( $sid ), array_unique( wp_list_pluck( $only['entries'], 'target' ) ) );
	}

	public function test_an_edit_says_what_changed() {
		$sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Sessions::save_as( array( 'id' => $sid, 'name' => 'Evening panel', 'maxLength' => 200 ), 'owner@example.org', false );
		$entry = QD_Activity::get( array( 'target' => $sid ) )['entries'][0];
		$this->assertSame( 'Session edited', $entry['action'] );
		$this->assertStringContainsString( 'renamed from "Morning panel"', $entry['details'] );
		$this->assertStringContainsString( 'length limit', $entry['details'] );
	}

	public function test_a_dry_run_checks_without_saving() {
		QD_Sessions::save_as( array( 'name' => 'Checked only' ), 'owner@example.org', true );
		$this->assertSame( array(), QD_Store::all_sessions() );
		$this->expectExceptionMessage( 'Give the session a name.' );
		QD_Sessions::save_as( array( 'name' => '' ), 'owner@example.org', true );
	}
}
