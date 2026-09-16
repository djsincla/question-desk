<?php
/** Summaries, the emails around an event, the CSV, retention and the health check. */

class Test_QD_Reports extends WP_UnitTestCase {

	private $sid;
	private $owner;
	public $mail = array();

	public function set_up() {
		parent::set_up();
		update_option( 'admin_email', 'owner@example.org' );
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
		QD_Settings::save_summary_defaults( array( 'extra' => 'reports@example.org' ) );
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'emailOnEnd' => true ), 'owner@example.org', false );
		QD_Sessions::set_active( $this->sid, true );
		add_filter( 'pre_wp_mail', array( $this, 'catch_mail' ), 10, 2 );
	}

	public function tear_down() {
		remove_filter( 'pre_wp_mail', array( $this, 'catch_mail' ), 10 );
		parent::tear_down();
	}

	public function catch_mail( $pre, $args ) {
		$this->mail[] = $args;
		return true;   // "sent", without touching the mail server
	}

	private function ask( $text, $topic = '', $status = 'new', $lang = '', $translation = '' ) {
		global $wpdb;
		$id = QD_Questions::insert( $this->sid, '', $text );
		$wpdb->update( QD_Install::table( 'questions' ),
			array( 'topic' => $topic, 'status' => $status, 'lang' => $lang, 'translation' => $translation ), array( 'id' => $id ) );
		QD_Cache::invalidate( $this->sid );
		return $id;
	}

	// ------------------------------------------------------------ summaries

	public function test_a_summary_shows_the_original_wording_and_the_translation() {
		$this->ask( 'Will there be a waiting list?', 'Waiting lists', 'answered', 'English', 'Will there be a waiting list?' );
		$this->ask( '대기자 명단이 있나요?', 'Waiting lists', 'new', 'Korean', 'Is there a waiting list?' );
		$this->ask( 'Not translated by anyone', 'Waiting lists' );
		$this->ask( 'A dismissed one', '', 'dismissed' );
		QD_Topics::change_vote( $this->sid, 'Waiting lists', true );

		$session = QD_Store::get_session( $this->sid );
		$content = QD_Summaries::content( $session, QD_Brand::for_session( $session ) );
		$this->assertSame( 3, $content['questions'] );
		$this->assertSame( 1, $content['topics'] );
		$this->assertStringContainsString( '3 questions in 1 topics · 1 dismissed', $content['body'] );
		$this->assertStringContainsString( 'Waiting lists', $content['body'] );
		$this->assertStringContainsString( '1 me too', $content['body'] );
		// The Korean question keeps both wordings; the English one needs only the one line.
		$this->assertStringContainsString( 'Is there a waiting list?', $content['body'] );
		$this->assertStringContainsString( 'Original (Korean): 대기자 명단이 있나요?', $content['body'] );
		$this->assertStringContainsString( 'Original wording — not translated', $content['body'] );
		$this->assertSame( 4, count( $content['rows'] ), 'the CSV keeps the dismissed one too' );
	}

	public function test_ending_a_session_emails_the_summary_with_a_csv() {
		$this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$result = QD_Sessions::end( $this->sid, 'Morning panel' );
		$this->assertSame( 1, $result['emailed'] );
		$this->assertSame( array( 'reports@example.org' ), (array) $this->mail[0]['to'] );
		$this->assertStringContainsString( 'Morning panel — questions summary', $this->mail[0]['subject'] );
		$this->assertStringContainsString( 'waiting list', $this->mail[0]['message'] );
		$this->assertStringEndsWith( 'Morning-panel-questions.csv', $this->mail[0]['attachments'][0] );
		$this->assertNotEmpty( QD_Store::get_session( $this->sid )['summarySent'] );
	}

	public function test_a_session_with_nobody_listed_says_so_instead_of_failing() {
		QD_Settings::save_summary_defaults( array( 'extra' => array() ) );
		$result = QD_Sessions::end( $this->sid, 'Morning panel' );
		$this->assertSame( 0, $result['emailed'] );
		$this->assertStringContainsString( 'Nobody is listed', $result['note'] );
		$this->assertSame( array(), $this->mail );
	}

	public function test_each_recipient_gets_their_own_message() {
		QD_Settings::save_summary_defaults( array( 'extra' => 'reports@example.org, board@example.org' ) );
		$this->ask( 'Will there be a waiting list?' );
		QD_Summaries::email_summary( $this->sid );
		$this->assertSame( 2, count( $this->mail ) );
		$this->assertSame( array( 'reports@example.org' ), (array) $this->mail[0]['to'] );
		$this->assertSame( array( 'board@example.org' ), (array) $this->mail[1]['to'] );
	}

	// ------------------------------------------------------------ event emails

	public function test_each_facilitator_is_emailed_only_their_own_sessions() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'ada@example.org' ) );
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'bo@example.org' ) );
		$eid = QD_Events::save( array( 'name' => 'Spring conference' ) )['savedEventId'];
		QD_Sessions::save_as( array( 'name' => 'Morning talk', 'eventId' => $eid, 'moderators' => array( 'ada@example.org' ) ), 'owner@example.org', false );
		QD_Sessions::save_as( array( 'name' => 'Afternoon talk', 'eventId' => $eid, 'moderators' => array( 'ada@example.org' ) ), 'owner@example.org', false );
		QD_Sessions::save_as( array( 'name' => 'Evening talk', 'eventId' => $eid, 'moderators' => array( 'bo@example.org' ) ), 'owner@example.org', false );

		$result = QD_EventTools::email_facilitators( $eid );
		$this->assertSame( array( 'facilitators' => 2, 'sessions' => 3 ), $result );
		$by_address = array();
		foreach ( $this->mail as $mail ) {
			$by_address[ is_array( $mail['to'] ) ? $mail['to'][0] : $mail['to'] ] = $mail;
		}
		$this->assertStringContainsString( 'Spring conference — your Question Desk sessions', $by_address['ada@example.org']['subject'] );
		$this->assertStringContainsString( 'Morning talk', $by_address['ada@example.org']['message'] );
		$this->assertStringContainsString( 'Afternoon talk', $by_address['ada@example.org']['message'] );
		$this->assertStringNotContainsString( 'Evening talk', $by_address['ada@example.org']['message'] );
		$this->assertStringContainsString( 'view=moderate', $by_address['bo@example.org']['message'] );
		$this->assertStringContainsString( 'Evening talk', $by_address['bo@example.org']['message'] );
	}

	public function test_an_event_summary_covers_every_session_in_one_email() {
		$eid = QD_Events::save( array( 'name' => 'Spring conference' ) )['savedEventId'];
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'eventId' => $eid ), 'owner@example.org', false );
		$this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$other = QD_Sessions::save_as( array( 'name' => 'Afternoon panel', 'eventId' => $eid ), 'owner@example.org', false );
		QD_Questions::insert( $other, '', 'Where do we park for the event?' );

		$this->assertSame( 1, QD_EventTools::email_event_summary( $eid ) );
		$mail = $this->mail[0];
		$this->assertStringContainsString( 'Spring conference — questions summary for the whole event', $mail['subject'] );
		$this->assertStringContainsString( 'Morning panel', $mail['message'] );
		$this->assertStringContainsString( 'Afternoon panel', $mail['message'] );
		$this->assertStringContainsString( '2 sessions · 2 questions', $mail['message'] );
		$this->assertStringEndsWith( 'Spring-conference-questions.csv', $mail['attachments'][0] );
	}

	public function test_links_can_be_emailed_to_the_people_running_a_session() {
		self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'ada@example.org' ) );
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'moderators' => array( 'ada@example.org' ) ), 'owner@example.org', false );

		$this->assertSame( 1, QD_EventTools::email_links( $this->sid, array( 'toModerators' => true, 'present' => true, 'moderate' => true ) ) );
		$this->assertStringContainsString( 'view=present', $this->mail[0]['message'] );
		$this->assertStringContainsString( 'view=moderate', $this->mail[0]['message'] );

		try {
			QD_EventTools::email_links( $this->sid, array( 'toModerators' => true, 'participant' => true ) );
			$this->fail( 'sent a shareable link for an in-room session' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'In-room sessions have no shareable link', $e->getMessage() );
		}
		$this->expectExceptionMessage( 'Choose at least one link to send.' );
		QD_EventTools::email_links( $this->sid, array( 'to' => array( 'someone@example.org' ) ) );
	}

	public function test_the_checklist_covers_the_site_and_every_session() {
		$eid = QD_Events::save( array( 'name' => 'Spring conference' ) )['savedEventId'];
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'eventId' => $eid, 'emailOnEnd' => true ), 'owner@example.org', false );
		$list = QD_EventTools::checklist( $eid );
		$this->assertSame( 'Spring conference', $list['event']['name'] );
		$this->assertSame( array( 'Question grouping runs every minute', 'Gemini is set up', 'Email' ), wp_list_pluck( $list['site'], 'label' ) );
		$session = $list['sessions'][0];
		$this->assertSame( 'Morning panel', $session['name'] );
		$this->assertStringContainsString( 'view=present', $session['links']['present'] );
		$labels = wp_list_pluck( $session['checks'], 'label' );
		$this->assertContains( 'QA Facilitators', $labels );
		$this->assertContains( 'Summary email', $labels );
	}

	// ------------------------------------------------------------ CSV

	public function test_sessions_export_and_import_again_unchanged() {
		$eid = QD_Events::save( array( 'name' => 'Spring conference' ) )['savedEventId'];
		QD_Sessions::save_as( array(
			'id' => $this->sid, 'name' => 'Morning panel', 'eventId' => $eid, 'heading' => 'Ask the panel',
			'access' => 'link', 'maxLength' => 240, 'cooldownSeconds' => 90, 'prepared' => array( 'What is planned for next year?' ),
		), 'owner@example.org', false );

		$export = QD_Csv::export_sessions();
		$this->assertSame( 1, $export['count'] );
		$this->assertStringStartsWith( "\u{FEFF}", $export['csv'] );
		$this->assertStringContainsString( 'Morning panel', $export['csv'] );

		$check = QD_Csv::import_sessions( $export['csv'], array(), true );
		$this->assertSame( 1, $check['updated'] );
		$this->assertSame( 0, $check['failed'] );
		$this->assertSame( array(), $check['rows'][0]['errors'] );

		QD_Csv::import_sessions( $export['csv'], array(), false );
		$session = QD_Store::get_session( $this->sid );
		$this->assertSame( 'Ask the panel', $session['heading'] );
		$this->assertSame( 240, $session['maxLength'] );
		$this->assertSame( 90, $session['cooldownSeconds'] );
		$this->assertSame( array( 'What is planned for next year?' ), QD_Questions::prepared_for( $this->sid ) );
		$this->assertSame( 1, count( QD_Store::all_sessions() ), 'no duplicate was made' );
	}

	public function test_importing_makes_new_sessions_and_events_and_reports_problems() {
		$csv = "Session,Event,Heading participants see,How people join (room or link),Scheduled start\r\n"
			. "\"Keynote\",\"Autumn day\",\"Ask the keynote\",link,\"2027-10-03 18:30\"\r\n"
			. "\"Workshop\",\"Autumn day\",\"Ask the workshop\",room,\r\n"
			. "\"Broken\",\"Autumn day\",\"\",sideways,\r\n"
			. ",,\"No name\",room,\r\n";
		$check = QD_Csv::import_sessions( $csv, array(), true );
		$this->assertSame( 2, $check['created'] );
		$this->assertSame( 2, $check['failed'] );
		$this->assertSame( array( 'Autumn day' ), $check['events'] );
		$this->assertStringContainsString( 'should be room or link', $check['rows'][2]['errors'][0] );
		$this->assertStringContainsString( 'No session name', $check['rows'][3]['errors'][0] );
		$this->assertSame( 1, count( QD_Store::all_sessions() ), 'checking changes nothing' );

		$result = QD_Csv::import_sessions( $csv, array(), false );
		$this->assertSame( 2, $result['created'] );
		$names = wp_list_pluck( QD_Store::all_sessions(), 'name' );
		$this->assertContains( 'Keynote', $names );
		$this->assertContains( 'Workshop', $names );
		$this->assertSame( array( 'Keynote', 'Workshop' ), array_slice( $names, 0, 2 ), 'new sessions keep the file order, on top' );
		$event = QD_Store::all_events()[0];
		$this->assertSame( 'Autumn day', $event['name'] );
		$keynote = QD_Store::all_sessions()[0];
		$this->assertSame( $event['id'], $keynote['eventId'] );
		$this->assertSame( 'link', $keynote['access'] );
		$this->assertNotEmpty( $keynote['scheduledStart'] );
	}

	public function test_importing_can_skip_duplicates_and_never_changes_an_ended_session() {
		$csv = "Session,Heading participants see\r\n\"Morning panel\",\"Changed by the file\"\r\n";
		$result = QD_Csv::import_sessions( $csv, array( 'duplicates' => 'skip' ), false );
		$this->assertSame( 1, $result['skipped'] );
		$this->assertNotSame( 'Changed by the file', QD_Store::get_session( $this->sid )['heading'] );

		QD_Sessions::end( $this->sid, 'Morning panel' );
		$result = QD_Csv::import_sessions( $csv, array(), false );
		$this->assertSame( 1, $result['skipped'] );
		$this->assertStringContainsString( 'has ended', $result['rows'][0]['warnings'][0] );
	}

	public function test_a_cell_that_looks_like_a_formula_is_stored_as_text() {
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'heading' => '=SUM(A1:A9)' ), 'owner@example.org', false );
		$export = QD_Csv::export_sessions();
		$this->assertStringContainsString( '"\'=SUM(A1:A9)"', $export['csv'] );
		// And it comes back without the guard.
		QD_Csv::import_sessions( $export['csv'], array(), false );
		$this->assertSame( '=SUM(A1:A9)', QD_Store::get_session( $this->sid )['heading'] );
	}

	// ------------------------------------------------------------ operations

	public function test_retention_takes_the_wording_out_of_old_questions_only() {
		$old = $this->ask( 'Something asked long ago', 'Waiting lists' );
		QD_Topics::save( $this->sid, 'Waiting lists', array( 'merged' => 'What about waiting lists?' ) );
		QD_Sessions::end( $this->sid, 'Morning panel' );
		QD_Store::update_session( $this->sid, function ( &$s ) {
			$s['ended'] = QD_Util::now_ms() - 200 * 24 * 3600 * 1000;   // over six months ago
		} );
		$recent = QD_Sessions::save_as( array( 'name' => 'Recent panel' ), 'owner@example.org', false );
		$keep   = QD_Questions::insert( $recent, '', 'A question from this week' );

		QD_Operations::save_ops( array( 'retentionMonths' => 6, 'weeklyReport' => false ) );
		$result = QD_Operations::apply_retention();
		$this->assertSame( 1, $result['questions'] );
		$this->assertStringContainsString( 'wording removed after 6 months', QD_Questions::get( $old )['text'] );
		$this->assertSame( 'A question from this week', QD_Questions::get( $keep )['text'] );
		$this->assertStringContainsString( 'wording removed', QD_Topics::records( $this->sid )['Waiting lists']['merged'] );
		$this->assertSame( 0, QD_Operations::apply_retention()['questions'], 'nothing is done twice' );
	}

	public function test_the_weekly_report_says_what_is_coming_and_what_needs_attention() {
		QD_Store::update_session( $this->sid, function ( &$s ) {
			$s['scheduledStart'] = QD_Util::now_ms() + 2 * 24 * 3600 * 1000;
		} );
		$this->ask( 'Will there be a waiting list?' );
		$report = QD_Operations::weekly_report();
		$this->assertSame( 1, $report['asked'] );
		$this->assertSame( array( 'Morning panel' ), $report['active'] );
		$this->assertStringContainsString( 'Morning panel', $report['upcoming'][0] );
		$this->assertSame( 'Gemini API key', $report['checks'][1]['name'] );
		$this->assertFalse( $report['checks'][1]['ok'], 'no key in the test site' );

		QD_Operations::save_ops( array( 'retentionMonths' => 0, 'weeklyReport' => true ) );
		$this->assertSame( 1, QD_Operations::send_weekly_report( 'owner@example.org' ) );
		$this->assertStringContainsString( 'Question Desk — weekly report', $this->mail[0]['subject'] );
		$this->assertStringContainsString( 'need attention', $this->mail[0]['message'] );
	}

	public function test_the_health_check_reports_on_what_an_administrator_can_fix() {
		$checks = QD_Operations::health_check()['checks'];
		$names  = wp_list_pluck( $checks, 'name' );
		$this->assertContains( 'Gemini API key', $names );
		$this->assertContains( 'Grouping and schedule run', $names );
		$this->assertContains( 'Database tables', $names );
		foreach ( $checks as $check ) {
			if ( 'Database tables' === $check['name'] ) {
				$this->assertTrue( $check['ok'], $check['detail'] );
			}
		}
	}

	public function test_a_load_test_makes_one_throwaway_session_and_takes_it_away_again() {
		QD_Operations::start_load_test();
		$view = QD_Operations::load_test_view();
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{32}$/', $view['key'] );
		$this->assertFalse( $view['expired'] );
		$this->assertStringContainsString( '--key ' . $view['key'], $view['command'] );
		$session = QD_Store::get_session( $view['sid'] );
		$this->assertTrue( $session['loadTest'] );
		$this->assertSame( 'active', $session['status'] );

		// The endpoint only answers with the key, and skips the per-room cap.
		$this->assertSame( 'notFound', QD_Operations::load_test_submit( 'wrong-key', 'A question' )['reason'] );
		QD_Cache::set( 'room_' . $view['sid'] . '_' . floor( QD_Util::now_ms() / 60000 ), (int) QD_App::config( 'roomLimitPerMinute' ), 120 );
		$this->assertTrue( QD_Operations::load_test_submit( $view['key'], 'A load test question for the panel' )['ok'] );

		QD_Operations::stop_load_test();
		$this->assertNull( QD_Operations::load_test_view() );
		$this->assertNull( QD_Store::get_session( $view['sid'] ) );
		$this->assertSame( array(), QD_Questions::rows( $view['sid'] ) );
	}

	public function test_a_load_test_session_stays_out_of_the_csv_and_the_weekly_report() {
		QD_Operations::start_load_test();
		$this->assertSame( 1, QD_Csv::export_sessions()['count'] );
		$this->assertSame( array( 'Morning panel' ), QD_Operations::weekly_report()['active'] );
	}
}
