<?php
/**
 * The staff catalog (APP_TEXT in server/strings.js, shipped as data/app.json): what the queue,
 * Admin, the coordinator portal and the room screen footer say, in each app language.
 */

class Test_QD_Words extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		update_option( 'admin_email', 'owner@example.org' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
	}

	public function test_a_staff_page_is_handed_one_language_and_a_phone_is_not() {
		$eid   = QD_Events::save( array( 'name' => 'Fall Conference' ) )['savedEventId'];
		$html  = QD_Pages::render( 'Coordinator.html', 'Fall Conference — event logistics', array(
			'eid'   => $eid,
			'board' => QD_Coordinator::board( $eid ),
		) );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $html, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( 'en', $boot['lang'] );
		$this->assertSame( 'Sorted', $boot['words']['coord.sorted'], 'the whole catalog, in one language' );
		$this->assertArrayNotHasKey( 'en', $boot['words'], 'not every language: the server already chose' );

		// The participant page picks its own language from BOOT.text instead.
		$ask = QD_Pages::render( 'Ask.html', 'Ask', array() );
		preg_match( '/var BOOT = (\{.*?\});\n/s', $ask, $m );
		$this->assertArrayNotHasKey( 'words', json_decode( $m[1], true ) );
	}

	public function test_a_phrase_falls_back_to_english_and_fills_in_its_values() {
		$this->assertSame( 'Sorted', QD_App::t( 'coord.sorted', null, 'es' ), 'English until someone writes the Spanish' );
		$this->assertSame( '3 waiting', QD_App::t( 'coord.waiting', array( 'n' => 3 ) ) );
		$this->assertSame( 'en', QD_App::app_language_code( 'fr' ), 'a language we do not have is English' );
		$this->expectException( QD_Error::class );
		QD_App::t( 'coord.nothing' );
	}

	public function test_every_phrase_matches_the_apps_script_catalog() {
		$data = QD_App::data();
		$this->assertNotEmpty( $data['appText'], 'the staff catalog crossed over in the build' );
		foreach ( $data['appText'] as $key => $languages ) {
			$this->assertNotEmpty( $languages['en'], $key . ' has no English' );
		}
		$words = QD_App::words_for( 'en' );
		$this->assertSame( array_keys( $data['appText'] ), array_keys( $words ) );
		$this->assertTrue( QD_App::has_words( 'Moderate.html' ) );
		$this->assertFalse( QD_App::has_words( 'Ask.html' ) );
	}

	public function test_a_person_reads_the_app_in_their_own_language_and_a_room_follows_its_session() {
		$coord = self::factory()->user->create( array( 'role' => 'qd_coordinator', 'user_email' => 'coord@example.org' ) );
		update_user_meta( $coord, 'qd_lang', 'es' );
		$this->assertSame( 'es', QD_App::app_language( 'coord@example.org' ) );
		$this->assertSame( 'en', QD_App::app_language( 'owner@example.org' ) );

		$eid = QD_Events::save( array( 'name' => 'Fall Conference' ) )['savedEventId'];
		$sid = QD_Sessions::save_as( array( 'name' => 'Keynote', 'eventId' => $eid ), 'owner@example.org', false );
		$this->assertSame( 'en', QD_App::room_language( QD_Store::get_session( $sid ) ) );

		update_option( 'qd_app_language', 'es' );
		$this->assertSame( 'es', QD_App::room_language( QD_Store::get_session( $sid ) ), 'the site\'s own language' );
		$this->assertSame( 'es', QD_App::app_language( 'owner@example.org' ), 'and anyone with no choice of their own' );
	}
}
