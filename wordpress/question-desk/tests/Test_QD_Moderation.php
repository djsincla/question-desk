<?php
/** The QA Facilitator queue: the board it draws and every action on it. */

class Test_QD_Moderation extends WP_UnitTestCase {

	private $sid;
	private $owner;
	private $mod;

	public function set_up() {
		parent::set_up();
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		$this->mod   = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'mod@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'moderators' => array( 'mod@example.org' ) ), 'owner@example.org', false );
		QD_Sessions::set_active( $this->sid, true );
		wp_set_current_user( $this->mod );
	}

	/** A question as it stands after a grouping run (phase 4 writes these for real). */
	private function ask( $text, $topic = '', $status = 'new', $device = '' ) {
		global $wpdb;
		$id = QD_Questions::insert( $this->sid, $device, $text );
		if ( $topic || 'new' !== $status ) {
			$wpdb->update( QD_Install::table( 'questions' ), array( 'topic' => $topic, 'status' => $status ), array( 'id' => $id ) );
			QD_Cache::invalidate( $this->sid );
		}
		return $id;
	}

	public function test_the_board_groups_questions_and_keeps_the_rest_apart() {
		$this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$this->ask( 'How long is the wait for respite?', 'Waiting lists' );
		$loose = $this->ask( 'Where do we park for the event?' );
		$this->ask( 'An old question nobody wants', '', 'dismissed' );
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'moderators' => array( 'mod@example.org' ), 'prepared' => array( 'What is planned for next year?' ) ), 'owner@example.org', false );

		$board = QD_Moderation::get_board( $this->sid );
		$this->assertSame( array( 'Waiting lists' ), wp_list_pluck( $board['topics'], 'topic' ) );
		$this->assertSame( 2, $board['topics'][0]['count'] );
		$this->assertFalse( $board['topics'][0]['shown'] );
		$this->assertSame( array( $loose ), wp_list_pluck( $board['unsorted'], 'id' ) );
		$this->assertSame( 1, count( $board['dismissed'] ) );
		$this->assertSame( array( 'What is planned for next year?' ), wp_list_pluck( $board['prepared'], 'text' ) );
		$this->assertSame( 'Morning panel', $board['session']['name'] );
		$this->assertTrue( $board['open'] );
		$this->assertFalse( $board['isAdmin'], 'a facilitator is not an administrator' );
	}

	public function test_topics_sort_by_interest_and_answered_ones_sink() {
		$this->ask( 'A parking question', 'Parking' );
		$this->ask( 'A waiting list question', 'Waiting lists' );
		$this->ask( 'Another waiting list question', 'Waiting lists' );
		$this->ask( 'An answered one', 'Already answered', 'answered' );
		QD_Topics::change_vote( $this->sid, 'Parking', true );
		QD_Topics::change_vote( $this->sid, 'Parking', true );

		$board = QD_Moderation::get_board( $this->sid );
		$this->assertSame( array( 'Parking', 'Waiting lists', 'Already answered' ), wp_list_pluck( $board['topics'], 'topic' ) );
		$this->assertSame( 2, $board['topics'][0]['votes'] );
		$this->assertTrue( $board['topics'][2]['answered'] );
	}

	public function test_marking_answered_and_dismissing_and_reopening() {
		$one = $this->ask( 'Will there be a waiting list?' );
		$two = $this->ask( 'Where do we park?' );

		$board = QD_Moderation::set_status( $this->sid, array( $one ), 'answered' );
		$this->assertSame( 'answered', QD_Questions::get( $one )['status'] );
		$this->assertSame( array( $two, $one ), wp_list_pluck( $board['unsorted'], 'id' ), 'answered ones sink' );

		QD_Moderation::set_status( $this->sid, array( $two ), 'dismissed' );
		$board = QD_Moderation::get_board( $this->sid );
		$this->assertSame( array( $two ), wp_list_pluck( $board['dismissed'], 'id' ) );

		QD_Moderation::set_status( $this->sid, array( $two ), 'new' );
		$this->assertSame( array(), QD_Moderation::get_board( $this->sid )['dismissed'] );

		$this->expectExceptionMessage( 'Unknown status.' );
		QD_Moderation::set_status( $this->sid, array( $one ), 'maybe' );
	}

	public function test_answering_the_live_question_takes_it_off_the_screen() {
		$one = $this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$two = $this->ask( 'How long is the wait?', 'Waiting lists' );
		QD_Moderation::set_now_answering( $this->sid, 'Waiting lists', '' );
		$this->assertSame( 'Waiting lists', QD_Moderation::get_board( $this->sid )['nowAnswering'] );

		QD_Moderation::set_status( $this->sid, array( $one ), 'answered' );
		$this->assertSame( 'Waiting lists', QD_Moderation::get_board( $this->sid )['nowAnswering'], 'one still open' );
		QD_Moderation::set_status( $this->sid, array( $two ), 'answered' );
		$this->assertNull( QD_Moderation::get_board( $this->sid )['nowAnswering'], 'the topic is finished' );
	}

	public function test_pausing_and_resuming_questions() {
		$board = QD_Moderation::set_board_open( $this->sid, false );
		$this->assertFalse( $board['open'] );
		$device = QD_Participants::claim_device( $this->sid, QD_Tokens::room_token( $this->sid )['token'] )['deviceId'];
		$this->assertSame( 'closed', QD_Participants::submit_question( $this->sid, $device, 'Can I still ask this?', '' )['reason'] );
		$this->assertTrue( QD_Moderation::set_board_open( $this->sid, true )['open'] );
		$this->assertTrue( QD_Participants::submit_question( $this->sid, $device, 'Can I ask now?', '' )['ok'] );
	}

	public function test_showing_a_topic_on_phones_needs_questions_in_it() {
		$this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$board = QD_Moderation::set_topic_shown( $this->sid, 'Waiting lists', true );
		$this->assertTrue( $board['topics'][0]['shown'] );

		$device = QD_Participants::claim_device( $this->sid, QD_Tokens::room_token( $this->sid )['token'] )['deviceId'];
		$this->assertSame( array( 'Waiting lists' ), wp_list_pluck( QD_Participants::get_topics( $this->sid, $device )['topics'], 'topic' ) );

		QD_Moderation::set_topic_shown( $this->sid, 'Waiting lists', false );
		$this->assertSame( array(), QD_Participants::get_topics( $this->sid, $device )['topics'] );

		$this->expectExceptionMessage( 'That topic has no questions.' );
		QD_Moderation::set_topic_shown( $this->sid, 'Something else', true );
	}

	public function test_one_ungrouped_question_can_go_on_phones_and_carries_its_me_toos_into_a_topic() {
		$id     = $this->ask( 'Will the program run again next spring?' );
		$device = QD_Participants::claim_device( $this->sid, QD_Tokens::room_token( $this->sid )['token'] )['deviceId'];

		$board = QD_Moderation::set_question_shown( $this->sid, $id, true );
		$this->assertTrue( $board['unsorted'][0]['shown'] );
		$this->assertSame( 'ungrouped', QD_Questions::get( $id )['grouping'], 'automatic grouping leaves it alone' );
		$this->assertSame( array( 'q:' . $id ), wp_list_pluck( QD_Participants::get_topics( $this->sid, $device )['topics'], 'topic' ) );
		QD_Participants::me_too( $this->sid, $device, 'q:' . $id );

		QD_Moderation::group_questions( $this->sid, array( $id ), 'Next year' );
		$this->assertSame( 'Next year', QD_Questions::get( $id )['topic'] );
		$topics = QD_Participants::get_topics( $this->sid, $device )['topics'];
		$this->assertSame( array( 'Next year' ), wp_list_pluck( $topics, 'topic' ), 'the topic is on phones in its place' );
		$this->assertSame( 2, $topics[0]['count'], 'the question plus the Me too it had' );
		$this->assertSame( 0, QD_Topics::votes( $this->sid )['q:' . $id ] ?? 0 );
	}

	public function test_a_question_in_a_topic_cannot_be_shown_on_its_own() {
		$id = $this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		$this->expectExceptionMessage( 'show the topic on phones instead' );
		QD_Moderation::set_question_shown( $this->sid, $id, true );
	}

	public function test_answer_now_on_one_question_and_stopping() {
		$id    = $this->ask( 'Will there be a waiting list?' );
		$board = QD_Moderation::set_now_answering( $this->sid, '', $id );
		$this->assertSame( $id, $board['nowAnsweringQuestion'] );
		$this->assertNotEmpty( $board['nowAnsweringSince'] );

		$board = QD_Moderation::set_now_answering( $this->sid, '', '' );
		$this->assertNull( $board['nowAnswering'] );
		$this->assertNull( $board['nowAnsweringQuestion'] );

		$this->expectExceptionMessage( 'no longer in the queue' );
		QD_Moderation::set_now_answering( $this->sid, '', 'ffffffff' );
	}

	public function test_answer_now_can_show_a_topic_on_phones_by_itself() {
		$this->ask( 'Will there be a waiting list?', 'Waiting lists' );
		QD_Moderation::set_auto_show_on_phones( $this->sid, true );
		QD_Moderation::set_now_answering( $this->sid, 'Waiting lists', '' );
		$this->assertTrue( QD_Moderation::get_board( $this->sid )['topics'][0]['shown'] );
	}

	public function test_grouping_and_ungrouping_by_hand() {
		$one = $this->ask( 'Will there be a waiting list?' );
		$two = $this->ask( 'How long is the wait for respite?' );

		$board = QD_Moderation::group_questions( $this->sid, array( $one, $two ), '  Waiting   lists ' );
		$this->assertSame( array( 'Waiting lists' ), wp_list_pluck( $board['topics'], 'topic' ), 'the name is tidied' );
		$this->assertSame( '', QD_Questions::get( $one )['grouping'], 'still translated by the next run' );

		$board = QD_Moderation::ungroup_questions( $this->sid, array( $one ) );
		$this->assertSame( 1, $board['topics'][0]['count'] );
		$this->assertSame( 'ungrouped', QD_Questions::get( $one )['grouping'], 'grouping leaves it alone afterwards' );

		try {
			QD_Moderation::group_questions( $this->sid, array( $one ), '' );
			$this->fail( 'grouped without a name' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'topic name', $e->getMessage() );
		}
		$this->expectExceptionMessage( 'Choose the questions to group.' );
		QD_Moderation::group_questions( $this->sid, array(), 'Waiting lists' );
	}

	public function test_prepared_questions_join_the_queue_when_added() {
		wp_set_current_user( $this->owner );
		QD_Sessions::save_as( array( 'id' => $this->sid, 'name' => 'Morning panel', 'moderators' => array( 'mod@example.org' ), 'prepared' => array( 'What is planned for next year?' ) ), 'owner@example.org', false );
		wp_set_current_user( $this->mod );

		$board = QD_Moderation::get_board( $this->sid );
		$this->assertSame( array(), $board['unsorted'], 'not a question anyone asked yet' );
		$id    = $board['prepared'][0]['id'];
		$board = QD_Moderation::use_prepared( $this->sid, array( $id ) );
		$this->assertSame( array( 'What is planned for next year?' ), wp_list_pluck( $board['unsorted'], 'text' ) );
		$this->assertSame( array(), $board['prepared'] );

		$this->expectExceptionMessage( 'already added or removed' );
		QD_Moderation::use_prepared( $this->sid, array( $id ) );
	}

	public function test_the_queue_switches_are_per_session() {
		$this->assertTrue( QD_Moderation::set_room_questions( $this->sid, true )['roomQuestions'] );
		$this->assertFalse( QD_Moderation::set_auto_group( $this->sid, false )['autoGroup'] );
		$this->assertTrue( QD_Moderation::set_auto_show_on_phones( $this->sid, true )['autoShowOnPhones'] );
		$session = QD_Store::get_session( $this->sid );
		$this->assertTrue( $session['roomQuestions'] );
		$this->assertFalse( $session['autoGroup'] );
	}

	public function test_only_this_sessions_facilitators_reach_the_queue() {
		$other = self::factory()->user->create( array( 'role' => 'qd_facilitator', 'user_email' => 'other@example.org' ) );
		wp_set_current_user( $other );
		try {
			QD_Moderation::get_board( $this->sid );
			$this->fail( 'read another queue' );
		} catch ( QD_Error $e ) {
			$this->assertStringContainsString( 'not a QA Facilitator for this session', $e->getMessage() );
		}
		$this->assertSame( array(), QD_Moderation::my_sessions() );
		wp_set_current_user( $this->mod );
		$this->assertSame( array( $this->sid ), wp_list_pluck( QD_Moderation::my_sessions(), 'id' ) );
	}

	public function test_an_ended_session_takes_no_more_changes() {
		$id = $this->ask( 'Will there be a waiting list?' );
		wp_set_current_user( $this->owner );
		QD_Sessions::end( $this->sid, 'Morning panel' );
		wp_set_current_user( $this->mod );

		$this->assertIsArray( QD_Moderation::get_board( $this->sid ), 'the queue can still be read' );
		$this->expectExceptionMessage( 'This session has ended.' );
		QD_Moderation::set_status( $this->sid, array( $id ), 'answered' );
	}

	public function test_a_queue_refresh_reads_the_questions_once_per_cache_window() {
		global $wpdb;
		for ( $i = 0; $i < 10; $i++ ) {
			$this->ask( 'Question number ' . $i . ' for the panel', 'Waiting lists' );
		}
		QD_Moderation::get_board( $this->sid );
		$before = $wpdb->num_queries;
		for ( $i = 0; $i < 10; $i++ ) {
			QD_Moderation::get_board( $this->sid );
		}
		$per_refresh = ( $wpdb->num_queries - $before ) / 10;
		$this->assertLessThan( 8, $per_refresh, 'queries per refresh: ' . $per_refresh );
	}
}
