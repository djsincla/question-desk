<?php
/** The every-minute run: sessions starting and ending on time, and grouping being kept going. */

class Test_QD_Schedule extends WP_UnitTestCase {

	private $owner;

	public function set_up() {
		parent::set_up();
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
	}

	private function session( array $input = array() ) {
		return QD_Sessions::save_as( array_merge( array( 'name' => 'Morning panel' ), $input ), 'owner@example.org', false );
	}

	public function test_a_session_starts_at_its_time_and_only_once() {
		$sid = $this->session( array( 'scheduledStart' => QD_Util::now_ms() + 60000 ) );
		QD_Schedule::run_sessions_schedule();
		$this->assertSame( 'inactive', QD_Store::get_session( $sid )['status'], 'not yet' );

		QD_Store::update_session( $sid, function ( &$s ) {
			$s['scheduledStart'] = QD_Util::now_ms() - 1000;
		} );
		$this->assertSame( 1, QD_Schedule::run_sessions_schedule() );
		$this->assertSame( 'active', QD_Store::get_session( $sid )['status'] );
		$this->assertNotEmpty( QD_Store::get_session( $sid )['started'] );

		// An administrator turns it off again: the schedule must not start it a second time.
		QD_Sessions::set_active( $sid, false );
		$this->assertSame( 0, QD_Schedule::run_sessions_schedule() );
		$this->assertSame( 'inactive', QD_Store::get_session( $sid )['status'] );
	}

	public function test_a_session_ends_at_its_time_and_stays_ended() {
		$sid = $this->session();
		QD_Sessions::set_active( $sid, true );
		QD_Store::update_session( $sid, function ( &$s ) {
			$s['scheduledEnd'] = QD_Util::now_ms() - 1000;
		} );
		$this->assertSame( 1, QD_Schedule::run_sessions_schedule() );
		$ended = QD_Store::get_session( $sid );
		$this->assertSame( 'ended', $ended['status'] );
		$this->assertFalse( $ended['open'] );
		$this->assertSame( 0, QD_Schedule::run_sessions_schedule(), 'nothing more to do' );

		$log = wp_list_pluck( QD_Activity::get( array( 'target' => $sid ) )['entries'], 'who' );
		$this->assertContains( 'Schedule (automatic)', $log, 'the log says the schedule did it' );
	}

	public function test_the_minute_run_is_scheduled_and_can_be_cleared() {
		QD_Schedule::schedule();
		$this->assertNotFalse( wp_next_scheduled( QD_Schedule::MINUTE_HOOK ) );
		QD_Schedule::unschedule();
		$this->assertFalse( wp_next_scheduled( QD_Schedule::MINUTE_HOOK ) );
	}

	public function test_a_queue_refresh_asks_for_grouping_when_it_is_due() {
		update_option( 'qd_gemini_key', 'test-key' );
		$mod = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$sid = $this->session( array( 'moderators' => array( 'mod@example.org' ) ) );
		QD_Sessions::set_active( $sid, true );
		wp_set_current_user( $mod );

		QD_Moderation::get_board( $sid );
		$this->assertNotFalse( wp_next_scheduled( QD_Schedule::SESSION_HOOK, array( $sid ) ), 'the first refresh asks' );

		wp_clear_scheduled_hook( QD_Schedule::SESSION_HOOK, array( $sid ) );
		QD_Moderation::get_board( $sid );
		$this->assertFalse( wp_next_scheduled( QD_Schedule::SESSION_HOOK, array( $sid ) ), 'and not again for a minute' );
	}

	public function test_nothing_is_asked_for_without_a_key_or_for_a_quiet_session() {
		delete_option( 'qd_gemini_key' );
		$mod = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		$sid = $this->session( array( 'moderators' => array( 'mod@example.org' ) ) );
		QD_Sessions::set_active( $sid, true );
		wp_set_current_user( $mod );
		QD_Moderation::get_board( $sid );
		$this->assertFalse( wp_next_scheduled( QD_Schedule::SESSION_HOOK, array( $sid ) ) );

		update_option( 'qd_gemini_key', 'test-key' );
		wp_set_current_user( $this->owner );
		QD_Sessions::set_active( $sid, false );
		wp_set_current_user( $mod );
		QD_Moderation::get_board( $sid );
		$this->assertFalse( wp_next_scheduled( QD_Schedule::SESSION_HOOK, array( $sid ) ), 'an inactive session is not grouped' );
	}

	public function test_failures_in_a_row_are_counted_and_cleared_on_recovery() {
		QD_Schedule::note_result( 'Gemini 503 upstream' );
		$health = QD_Schedule::note_result( 'Gemini 503 upstream' );
		$this->assertSame( 2, $health['failures'] );
		$this->assertSame( 'Gemini 503 upstream', $health['lastError'] );

		$health = QD_Schedule::note_result( '' );
		$this->assertSame( 0, $health['failures'] );
		$this->assertNotEmpty( $health['lastOkAt'] );
	}
}
