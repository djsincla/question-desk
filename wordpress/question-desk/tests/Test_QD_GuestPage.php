<?php
/**
 * The guest page: a copy of docs/join hosted by the organization that frames this site's pages,
 * so links can be shaped the same way in both versions of Question Desk.
 */

class Test_QD_GuestPage extends WP_UnitTestCase {

	private $sid;

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
		$this->sid = QD_Sessions::save_as( array( 'name' => 'Morning panel', 'access' => 'link' ), 'owner@example.org', false );
	}

	private function links( $input ) {
		QD_Sessions::save_as( array_merge( array( 'id' => $this->sid, 'name' => 'Morning panel', 'access' => 'link' ), $input ), 'owner@example.org', false );
		return QD_Sessions::links( QD_Store::get_session( $this->sid ) );
	}

	public function test_without_a_guest_page_links_open_this_site() {
		$links = QD_Sessions::links( QD_Store::get_session( $this->sid ) );
		foreach ( array( 'present', 'panel', 'slide', 'participant' ) as $which ) {
			$this->assertStringStartsWith( QD_Router::base_url(), $links[ $which ], $which );
		}
	}

	public function test_each_link_goes_through_the_guest_page_only_when_its_own_box_is_ticked() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa' ) );
		$this->assertSame( 'https://autismla.example/qa/', QD_Settings::guest_page_url(), 'a folder gets its slash' );

		$links = $this->links( array( 'guestPage' => array( 'room' => true, 'slide' => false, 'panel' => false ) ) );
		$this->assertStringStartsWith( 'https://autismla.example/qa/?view=present&s=' . $this->sid, $links['present'] );
		$this->assertStringStartsWith( QD_Router::base_url(), $links['slide'], 'the slide keeps its own choice' );
		$this->assertStringStartsWith( QD_Router::base_url(), $links['panel'] );
		// The shareable questions link follows the room screen or the slide.
		$this->assertStringStartsWith( 'https://autismla.example/qa/?s=' . $this->sid . '&k=', $links['participant'] );
		// The queue is for signed-in staff: never through a guest page.
		$this->assertStringStartsWith( QD_Router::base_url(), $links['moderate'] );

		$links = $this->links( array( 'guestPage' => array( 'room' => false, 'slide' => true, 'panel' => true ) ) );
		$this->assertStringStartsWith( 'https://autismla.example/qa/?view=present&', $links['slide'] );
		$this->assertStringEndsWith( '&layout=qr', $links['slide'] );
		$this->assertStringStartsWith( 'https://autismla.example/qa/?view=panel&', $links['panel'] );
		$this->assertStringStartsWith( QD_Router::base_url(), $links['present'] );
	}

	public function test_a_session_can_use_its_own_guest_page_address() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		$links = $this->links( array( 'guestPage' => array( 'room' => true, 'url' => 'https://spring.example/ask/index.html' ) ) );
		$this->assertStringStartsWith( 'https://spring.example/ask/index.html?view=present&', $links['present'] );
	}

	public function test_the_link_never_carries_a_site_of_its_own() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		$links = $this->links( array( 'guestPage' => array( 'room' => true, 'slide' => true ) ) );
		foreach ( array( 'present', 'slide', 'participant' ) as $which ) {
			// The hosted copy names the site (data-site); a link that could name one would let
			// anybody show any website at the organization's own address.
			$this->assertStringNotContainsString( 'http', substr( $links[ $which ], strpos( $links[ $which ], '?' ) ), $which );
		}
	}

	public function test_a_guest_page_address_is_checked_before_it_is_saved() {
		foreach ( array( 'http://autismla.example/qa/', 'https://autismla.example/qa/?d=1', 'not a url', 'https://autismla.example/qa/#x' ) as $bad ) {
			try {
				QD_Settings::save_brand( array( 'guestPageUrl' => $bad ) );
				$this->fail( 'saved ' . $bad );
			} catch ( QD_Error $e ) {
				$this->assertStringContainsString( 'guest page address must be', $e->getMessage() );
			}
		}
		QD_Settings::save_brand( array( 'guestPageUrl' => '' ) );
		$this->assertSame( '', QD_Settings::guest_page_url(), 'blank turns it off' );
	}

	public function test_the_admin_page_is_told_the_address_it_shows() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		$state = QD_Admin::state();
		$this->assertSame( 'https://autismla.example/qa/', $state['guestPageUrl'] );
		$this->assertNotEmpty( $state['guestPageDefault'] );
		$session = $state['sessions'][0];
		$this->assertSame( array( 'room' => false, 'slide' => false, 'panel' => false, 'url' => '' ), $session['guestPage'] );
	}

	public function test_the_room_screen_hands_out_a_joining_link_through_the_guest_page_too() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		$this->links( array( 'guestPage' => array( 'room' => true ) ) );
		QD_Sessions::set_active( $this->sid, true );
		$session = QD_Store::get_session( $this->sid );

		$screen = QD_Screen::get_room_screen( $this->sid, 'full', $session['screenKey'] );
		$this->assertStringStartsWith( 'https://autismla.example/qa/?s=' . $this->sid . '&k=', $screen['url'],
			'the QR code on the screen uses the same guest page' );
	}

	public function test_the_guest_page_settings_survive_the_sessions_csv() {
		QD_Settings::save_brand( array( 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		$this->links( array( 'guestPage' => array( 'room' => true, 'slide' => true, 'panel' => false, 'url' => 'https://spring.example/ask/' ) ) );

		$csv = QD_Csv::export_sessions();
		$this->assertStringContainsString( 'https://spring.example/ask/', $csv['csv'] );
		QD_Csv::import_sessions( $csv['csv'], array(), false );

		$guest = QD_Sessions::guest_choice( QD_Store::get_session( $this->sid )['guestPage'] );
		$this->assertTrue( $guest['room'] );
		$this->assertTrue( $guest['slide'] );
		$this->assertFalse( $guest['panel'] );
		$this->assertSame( 'https://spring.example/ask/', $guest['url'] );
	}
}
