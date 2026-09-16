<?php
/** Packaging and the bridge from the Apps Script version: importing a summary CSV. */

class Test_QD_Package extends WP_UnitTestCase {

	private $sid;

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Imported panel' ), 'owner@example.org', false );
	}

	/** Exactly what the Apps Script version attaches to a summary email. */
	private function summary_csv() {
		return "ID,Submitted,Status,Topic,Original language,Original question,English translation,Merged question for topic,Me too (topic),Topic shown on phones\r\n"
			. '"1a2b3c4d","Oct 3, 2026 6:32 pm","answered","Waiting lists","Korean","대기자 명단이 있나요?","Is there a waiting list?","What are the plans for waiting lists?","3","yes"' . "\r\n"
			. '"2a2b3c4e","Oct 3, 2026 6:35 pm","new","Waiting lists","English","How long is the wait?","How long is the wait?","What are the plans for waiting lists?","3","yes"' . "\r\n"
			. '"3a2b3c4f","Oct 3, 2026 6:40 pm","dismissed","","English","Nonsense","Nonsense","","0","no"' . "\r\n";
	}

	public function test_a_summary_csv_can_be_loaded_into_a_session_here() {
		$check = QD_Csv::import_questions( $this->sid, $this->summary_csv(), true );
		$this->assertSame( 3, $check['added'] );
		$this->assertSame( 0, $check['failed'] );
		$this->assertSame( array( 'Waiting lists' ), $check['topics'] );
		$this->assertSame( array(), QD_Questions::rows( $this->sid, true ), 'checking changes nothing' );

		$result = QD_Csv::import_questions( $this->sid, $this->summary_csv(), false );
		$this->assertSame( 3, $result['added'] );

		$rows = QD_Questions::rows( $this->sid, true );
		$this->assertSame( 3, count( $rows ) );
		$first = QD_Questions::get( '1a2b3c4d' );
		$this->assertSame( '대기자 명단이 있나요?', $first['text'] );
		$this->assertSame( 'Is there a waiting list?', $first['translation'] );
		$this->assertSame( 'Korean', $first['lang'] );
		$this->assertSame( 'answered', $first['status'] );
		$this->assertSame( 'Waiting lists', $first['topic'] );
		$this->assertSame( 'imported', $first['device'] );
		$this->assertGreaterThan( 0, $first['submitted'] );

		$records = QD_Topics::records( $this->sid );
		$this->assertSame( 'What are the plans for waiting lists?', $records['Waiting lists']['merged'] );
		$this->assertTrue( $records['Waiting lists']['shown'] );
		$this->assertSame( 3, QD_Topics::votes( $this->sid )['Waiting lists'], 'the Me too count comes across' );
	}

	public function test_importing_the_same_file_twice_changes_nothing() {
		QD_Csv::import_questions( $this->sid, $this->summary_csv(), false );
		$again = QD_Csv::import_questions( $this->sid, $this->summary_csv(), false );
		$this->assertSame( 0, $again['added'] );
		$this->assertSame( 3, $again['skipped'] );
		$this->assertSame( 3, count( QD_Questions::rows( $this->sid, true ) ) );
	}

	public function test_the_imported_session_reads_like_any_other() {
		QD_Csv::import_questions( $this->sid, $this->summary_csv(), false );
		$board = QD_Moderation::get_board( $this->sid );
		$this->assertSame( array( 'Waiting lists' ), wp_list_pluck( $board['topics'], 'topic' ) );
		$this->assertSame( 2, $board['topics'][0]['count'] );
		$this->assertSame( 3, $board['topics'][0]['votes'] );
		$this->assertSame( 1, count( $board['dismissed'] ) );

		$session = QD_Store::get_session( $this->sid );
		$content = QD_Summaries::content( $session, QD_Brand::for_session( $session ) );
		$this->assertSame( 2, $content['questions'] );
		$this->assertStringContainsString( 'Original (Korean): 대기자 명단이 있나요?', $content['body'] );
	}

	public function test_a_file_that_is_not_a_summary_csv_says_so() {
		try {
			QD_Csv::import_questions( $this->sid, "Name,Email\r\nsomeone,someone@example.org\r\n", true );
			$this->fail( 'imported the wrong kind of file' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Original question', $e->getMessage() );
		}
		try {
			QD_Csv::import_questions( 'ffffffff', $this->summary_csv(), true );
			$this->fail( 'imported into a session that does not exist' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'Session not found.', $e->getMessage() );
		}
		$this->expectExceptionMessage( 'The file is empty.' );
		QD_Csv::import_questions( $this->sid, '', true );
	}

	public function test_only_administrators_may_import() {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) ) );
		$this->expectExceptionMessage( 'Only administrators can do that.' );
		QD_Csv::import_questions( $this->sid, $this->summary_csv(), true );
	}

	public function test_the_plugin_says_which_version_it_is() {
		$header = file_get_contents( QD_DIR . 'question-desk.php' );
		preg_match( '/^\s*\*\s*Version:\s*([0-9][0-9.]*)\s*$/m', $header, $found );
		$this->assertSame( QD_VERSION, $found[1], 'the plugin header and QD_VERSION must agree' );
		$this->assertSame( QD_App::data()['appVersion'], QD_VERSION, 'and match the app both versions share' );
	}
}
