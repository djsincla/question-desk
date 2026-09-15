<?php
/**
 * Removing the plugin (Plugins → Delete) removes its tables, options and role. Deactivating keeps
 * everything.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;
foreach ( array( 'events', 'sessions', 'questions', 'topics', 'votes', 'activity', 'archive' ) as $name ) {
	$wpdb->query( 'DROP TABLE IF EXISTS ' . $wpdb->prefix . 'qd_' . $name ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
}
foreach ( wp_load_alloptions() as $option => $value ) {
	if ( 0 === strpos( $option, 'qd_' ) ) {
		delete_option( $option );
	}
}
remove_role( 'qd_facilitator' );
$admin = get_role( 'administrator' );
if ( $admin ) {
	$admin->remove_cap( 'qd_manage' );
	$admin->remove_cap( 'qd_facilitate' );
}
