<?php
/** Activation: tables, roles and capabilities. */

class Test_QD_Install extends WP_UnitTestCase {

	public function test_tables_exist() {
		global $wpdb;
		foreach ( array( 'events', 'sessions', 'questions', 'topics', 'votes', 'activity', 'archive' ) as $name ) {
			$table = QD_Install::table( $name );
			$this->assertSame( $table, $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ), $name );
		}
	}

	public function test_roles_and_capabilities() {
		$facilitator = get_role( 'qd_facilitator' );
		$this->assertNotNull( $facilitator );
		$this->assertTrue( $facilitator->has_cap( 'qd_facilitate' ) );
		$this->assertFalse( $facilitator->has_cap( 'qd_manage' ) );
		$admin = get_role( 'administrator' );
		$this->assertTrue( $admin->has_cap( 'qd_manage' ) );
		$this->assertTrue( $admin->has_cap( 'qd_facilitate' ) );
	}

	public function test_upgrade_runs_once_per_version() {
		update_option( 'qd_db_version', '0' );
		QD_Install::maybe_upgrade();
		$this->assertSame( QD_Install::DB_VERSION, get_option( 'qd_db_version' ) );
	}
}
