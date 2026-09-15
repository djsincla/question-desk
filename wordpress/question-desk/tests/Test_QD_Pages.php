<?php
/** Rendering the shared page files: BOOT, styles and scripts sections, text, the transport. */

class Test_QD_Pages extends WP_UnitTestCase {

	public function test_home_page_has_its_styles_text_and_transport() {
		update_option( 'qd_brand', array( 'orgName' => 'Example Society' ) );
		$html = QD_Pages::render( 'Home.html', 'Example Society — Question Desk', array( 'languages' => array( 'en', 'ko' ) ) );
		$this->assertStringContainsString( '<title>Example Society — Question Desk</title>', $html );
		$this->assertStringNotContainsString( '<?!=', $html, 'every template slot is filled' );
		$this->assertMatchesRegularExpression( '/<style>\n[\s\S]{1000,}<\/style>/', $html, 'the shared and Home sections of Styles.html' );
		$this->assertStringNotContainsString( 'data-pages', $html );
		$this->assertStringContainsString( 'function el(', $html, 'the Home section of Scripts.html' );
		$this->assertStringContainsString( 'window.QD_CONFIG', $html );
		$this->assertStringContainsString( 'assets/qd-run.js', $html );
		$this->assertLessThan( strpos( $html, 'var BOOT' ), strpos( $html, 'qd-run.js' ), 'the transport loads before the page script' );

		preg_match( '/var BOOT = (\{.*?\});\n/s', $html, $m );
		$boot = json_decode( $m[1], true );
		$this->assertSame( 'Example Society', $boot['brand']['orgName'] );
		$this->assertArrayHasKey( 'ko', $boot['text'], 'participant-facing text from the shared catalog' );
		$this->assertSame( array( 'en', 'ko' ), $boot['languages'] );
	}

	public function test_boot_json_is_safe_inside_a_script() {
		$json = QD_Pages::boot_json( array( 'x' => "</script><script>alert(1)</script>\u{2028}\u{2029}" ) );
		$this->assertStringNotContainsString( '<', $json );
		$this->assertStringNotContainsString( "\u{2028}", $json );
		$this->assertStringContainsString( '\\u003c/script', $json );
	}

	public function test_pages_get_only_their_own_sections() {
		$ask = QD_Pages::render( 'Ask.html', 'Ask', array() );
		$this->assertStringNotContainsString( '#gemForm', $ask, 'phones never download the Admin styles' );
		$present = QD_Pages::render( 'Present.html', 'Room', array() );
		$this->assertStringContainsString( 'function qrArt(', $present );
		$this->assertStringContainsString( 'qr-only', $present );
	}

	public function test_page_files_are_the_shared_ones() {
		$this->expectException( QD_Error::class );
		QD_App::page_file( '../wp-config.php' );
	}
}
