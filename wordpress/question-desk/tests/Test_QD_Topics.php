<?php
/** What phones may see: approved topic labels in every language, Me too, and Now answering. */

class Test_QD_Topics extends WP_UnitTestCase {

	private $sid;
	private $owner;

	public function set_up() {
		parent::set_up();
		$this->owner = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) );
		wp_set_current_user( $this->owner );
		QD_Store::reset_cache();
		QD_Settings::save_site_languages( array( 'ko', 'es' ) );
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Sessions::set_active( $this->sid, true );
		wp_set_current_user( 0 );
	}

	private function join( $sid = null ) {
		$sid = $sid ? $sid : $this->sid;
		return QD_Participants::claim_device( $sid, QD_Tokens::room_token( $sid )['token'] )['deviceId'];
	}

	/** A question already grouped and translated, as phase 4's grouping run will leave it. */
	private function grouped( $text, $topic, $status = 'new', $device = '' ) {
		global $wpdb;
		$id = QD_Questions::insert( $this->sid, $device, $text );
		$wpdb->update(
			QD_Install::table( 'questions' ),
			array( 'topic' => $topic, 'status' => $status, 'lang' => 'English', 'translations' => wp_json_encode( array( 'ko' => $topic . ' (KO)', 'es' => $topic . ' (ES)' ) ) ),
			array( 'id' => $id )
		);
		QD_Cache::invalidate( $this->sid );
		return $id;
	}

	private function show( $topic ) {
		QD_Topics::save( $this->sid, $topic, array(
			'shown'  => 1,
			'labels' => wp_json_encode( array( 'ko' => $topic . ' (KO)', 'es' => $topic . ' (ES)' ) ),
		) );
	}

	public function test_phones_see_approved_labels_in_every_language_never_question_text() {
		$this->grouped( 'Will there be a waiting list for the program?', 'Waiting lists' );
		$device = $this->join();
		$this->assertSame( array(), QD_Participants::get_topics( $this->sid, $device )['topics'], 'nothing before a facilitator approves it' );

		$this->show( 'Waiting lists' );
		$topics = QD_Participants::get_topics( $this->sid, $device )['topics'];
		$this->assertSame( 1, count( $topics ) );
		$this->assertSame( 'Waiting lists', $topics[0]['topic'] );
		$this->assertSame( 'Waiting lists (KO)', $topics[0]['labels']['ko'] );
		$this->assertSame( 'Waiting lists', $topics[0]['labels']['en'] );
		$this->assertSame( 1, $topics[0]['count'] );
		$this->assertStringNotContainsString( 'waiting list for the program', wp_json_encode( $topics ) );
	}

	public function test_ungrouped_dismissed_and_answered_topics_stay_off_phones() {
		$this->grouped( 'Not in any topic at all, just asked', '' );
		$this->grouped( 'A dismissed question about parking', 'Parking', 'dismissed' );
		$this->grouped( 'An answered question about funding', 'Funding', 'answered' );
		$this->show( 'Parking' );
		$this->show( 'Funding' );
		$device = $this->join();
		$this->assertSame( array(), QD_Participants::get_topics( $this->sid, $device )['topics'] );

		// One answered and one still open in the same topic: the topic stays.
		$this->grouped( 'Another funding question still open', 'Funding' );
		$topics = QD_Participants::get_topics( $this->sid, $device )['topics'];
		$this->assertSame( array( 'Funding' ), wp_list_pluck( $topics, 'topic' ) );
	}

	public function test_a_single_question_a_facilitator_shows_gets_its_own_entry() {
		$id = $this->grouped( 'Will the program run again next spring?', '' );
		wp_set_current_user( $this->owner );
		QD_Store::update_session( $this->sid, function ( &$s ) use ( $id ) {
			$s['shownQuestions'] = array( $id );
		} );
		wp_set_current_user( 0 );
		QD_Cache::invalidate( $this->sid );

		$topics = QD_Participants::get_topics( $this->sid, $this->join() )['topics'];
		$this->assertSame( array( 'q:' . $id ), wp_list_pluck( $topics, 'topic' ) );
		$this->assertSame( 'Will the program run again next spring?', $topics[0]['labels']['en'] );
	}

	public function test_topics_need_a_joined_device() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$this->assertSame( 'expired', QD_Participants::get_topics( $this->sid, 'made-up' )['reason'] );
		$this->assertSame( 'notFound', QD_Participants::get_topics( 'ffffffff', 'made-up' )['reason'] );
	}

	public function test_me_too_toggles_once_per_device_and_counts_toward_the_topic() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$one = $this->join();
		$two = $this->join();

		$this->assertSame( array( 'ok' => true, 'mine' => true, 'votes' => 1 ), QD_Participants::me_too( $this->sid, $one, 'Waiting lists' ) );
		$this->assertSame( array( 'ok' => true, 'mine' => false, 'votes' => 0 ), QD_Participants::me_too( $this->sid, $one, 'Waiting lists' ), 'tapping again takes it back' );
		QD_Participants::me_too( $this->sid, $one, 'Waiting lists' );
		QD_Participants::me_too( $this->sid, $two, 'Waiting lists' );

		$topics = QD_Participants::get_topics( $this->sid, $one )['topics'];
		$this->assertSame( 3, $topics[0]['count'], 'one question plus two Me toos' );
		$this->assertTrue( $topics[0]['mine'] );
		$this->assertFalse( QD_Participants::get_topics( $this->sid, $this->join() )['topics'][0]['mine'] );
	}

	public function test_me_too_is_refused_for_unknown_topics_and_closed_sessions() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$device = $this->join();
		$this->assertSame( 'unknownTopic', QD_Participants::me_too( $this->sid, $device, 'Something else' )['reason'] );
		$this->assertSame( 'expired', QD_Participants::me_too( $this->sid, 'made-up', 'Waiting lists' )['reason'] );

		wp_set_current_user( $this->owner );
		QD_Sessions::set_active( $this->sid, false );
		wp_set_current_user( 0 );
		$this->assertSame( 'inactive', QD_Participants::me_too( $this->sid, $device, 'Waiting lists' )['reason'] );

		wp_set_current_user( $this->owner );
		QD_Sessions::end( $this->sid, 'Morning panel' );
		wp_set_current_user( 0 );
		$this->assertSame( 'ended', QD_Participants::me_too( $this->sid, $device, 'Waiting lists' )['reason'] );
	}

	public function test_me_too_has_a_room_wide_cap_per_minute() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$cap = (int) QD_App::config( 'meTooLimitPerMinute' );
		QD_Cache::set( 'metoo_' . $this->sid . '_' . floor( QD_Util::now_ms() / 60000 ), $cap, 120 );
		$this->assertSame( 'busy', QD_Participants::me_too( $this->sid, $this->join(), 'Waiting lists' )['reason'] );
	}

	public function test_a_phone_sees_its_own_answered_questions_and_no_one_elses() {
		$mine = $this->join();
		$id   = $this->grouped( 'My own question about the waiting list', 'Waiting lists', 'answered', $mine );
		$this->grouped( 'Someone else asked about parking', 'Parking', 'answered', $this->join() );
		$this->show( 'Waiting lists' );

		$answer = QD_Participants::get_topics( $this->sid, $mine );
		$this->assertSame( array( $id ), $answer['mineAnswered'] );
	}

	public function test_now_answering_reaches_phones_in_every_language() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		QD_Topics::save( $this->sid, 'Waiting lists', array(
			'merged'        => 'What are the plans for waiting lists?',
			'merged_labels' => wp_json_encode( array( 'ko' => 'Waiting lists merged (KO)', 'es' => 'Waiting lists merged (ES)' ) ),
		) );
		wp_set_current_user( $this->owner );
		QD_Store::update_session( $this->sid, function ( &$s ) {
			$s['nowAnswering'] = array( 'topic' => 'Waiting lists', 'at' => QD_Util::now_ms() );
		} );
		wp_set_current_user( 0 );
		QD_Cache::invalidate( $this->sid );

		$now = QD_Participants::get_topics( $this->sid, $this->join() )['nowAnswering'];
		$this->assertSame( 'Waiting lists', $now['topic'] );
		$this->assertSame( 'Waiting lists (KO)', $now['labels']['ko'] );
		$this->assertSame( 'What are the plans for waiting lists?', $now['merged']['en'] );
		$this->assertSame( 'Waiting lists merged (ES)', $now['merged']['es'] );
		$this->assertNotEmpty( $now['since'] );
	}

	public function test_a_full_room_polling_reads_the_questions_once_per_cache_window() {
		global $wpdb;
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$device = $this->join();
		QD_Participants::get_topics( $this->sid, $device );   // fills the cache

		$before = $wpdb->num_queries;
		for ( $i = 0; $i < 20; $i++ ) {
			QD_Participants::get_topics( $this->sid, $device );
		}
		$per_poll = ( $wpdb->num_queries - $before ) / 20;
		$this->assertLessThan( 6, $per_poll, 'queries per poll: ' . $per_poll );
	}

	public function test_a_change_is_never_hidden_by_something_cached_from_before_it() {
		$this->grouped( 'Will there be a waiting list?', 'Waiting lists' );
		$this->show( 'Waiting lists' );
		$device = $this->join();
		$this->assertSame( 1, count( QD_Participants::get_topics( $this->sid, $device )['topics'] ) );

		// A request that read before the change: it builds its answer, the change lands, and
		// only then does it cache. The old answer must never be served afterwards.
		$session = QD_Store::get_session( $this->sid );
		$stale   = QD_Topics::public_topics( $session );
		QD_Topics::save( $this->sid, 'Waiting lists', array( 'shown' => 0 ) );
		QD_Cache::set( 'topics_' . $this->sid, array( 'v' => 'from-before', 'data' => $stale ), 5 );

		$this->assertSame( array(), QD_Participants::get_topics( $this->sid, $device )['topics'] );
	}
}
