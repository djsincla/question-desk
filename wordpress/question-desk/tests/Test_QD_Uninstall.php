<?php
/** Deleting the plugin must leave nothing behind — including the settings nobody can see. */

class Test_QD_Uninstall extends WP_UnitTestCase {

	/**
	 * uninstall.php deletes rows named qd_* (and their transients). Anything the plugin stores
	 * under another name would be left behind, so every option it writes is checked here rather
	 * than by running the uninstall, which would drop the tables this suite is using.
	 */
	public function test_every_option_the_plugin_writes_is_named_qd() {
		$names = array();
		foreach ( glob( QD_DIR . 'includes/*.php' ) as $file ) {
			preg_match_all( "/(?:update_option|add_option|delete_option|get_option)\(\s*'([^']+)'/", file_get_contents( $file ), $found );
			$names = array_merge( $names, $found[1] );
		}
		$names = array_unique( $names );
		$this->assertNotEmpty( $names );
		$theirs = array( 'admin_email' );   // WordPress's own, read but never written
		foreach ( array_diff( $names, $theirs ) as $name ) {
			$this->assertStringStartsWith( 'qd_', $name, $name . ' would survive deleting the plugin' );
		}
	}

	public function test_the_uninstall_file_clears_settings_that_are_not_autoloaded() {
		$source = file_get_contents( QD_DIR . 'uninstall.php' );
		$this->assertStringContainsString( 'DELETE FROM $wpdb->options WHERE option_name LIKE', $source );
		$this->assertStringContainsString( '_transient_qd_', $source, 'and the transients' );
		// Not by walking the autoloaded options, which is where the settings would be missed.
		$this->assertDoesNotMatchRegularExpression( '/wp_load_alloptions\s*\(/', $source );
		foreach ( array( 'events', 'sessions', 'questions', 'topics', 'votes', 'activity', 'archive' ) as $table ) {
			$this->assertStringContainsString( "'" . $table . "'", $source, $table . ' table' );
		}
		$this->assertStringContainsString( "wp_clear_scheduled_hook( 'qd_minute' )", $source, 'and the every-minute run' );
	}

	public function test_the_settings_it_writes_really_are_reachable_by_that_pattern() {
		global $wpdb;
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'owner@example.org' ) ) );
		QD_Store::reset_cache();
		QD_Settings::save_brand( array( 'orgName' => 'Example Society', 'guestPageUrl' => 'https://autismla.example/qa/' ) );
		QD_Operations::save_ops( array( 'retentionMonths' => 6, 'weeklyReport' => true ) );
		update_option( 'qd_gemini_key', 'test-key', false );
		$sid = QD_Sessions::save_as( array( 'name' => 'Morning panel' ), 'owner@example.org', false );
		QD_Tokens::room_token( $sid );   // qd_token_<sid>, not autoloaded

		$found = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM $wpdb->options WHERE option_name LIKE %s", $wpdb->esc_like( 'qd_' ) . '%' ) ); // phpcs:ignore WordPress.DB.PreparedSQL
		foreach ( array( 'qd_brand', 'qd_guest_page', 'qd_ops', 'qd_gemini_key', 'qd_token_' . $sid ) as $name ) {
			$this->assertContains( $name, $found, $name . ' must be deleted with the plugin' );
		}
	}
}
