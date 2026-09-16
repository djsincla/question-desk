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
// Every option and transient this plugin writes is named qd_*. Walking only the autoloaded
// options would miss most of them — the settings read in the admin area, the Gemini key and the
// room codes are all stored without autoload, so the key itself would have been left behind.
$like = $wpdb->esc_like( 'qd_' ) . '%';
$wpdb->query( $wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQL
	"DELETE FROM $wpdb->options WHERE option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s",
	$like,
	$wpdb->esc_like( '_transient_qd_' ) . '%',
	$wpdb->esc_like( '_transient_timeout_qd_' ) . '%'
) );
wp_cache_flush();
wp_clear_scheduled_hook( 'qd_minute' );
// The roles go; the accounts stay. A user who had one keeps it in their own settings, so
// installing Question Desk again gives them their role back.
remove_role( 'qd_facilitator' );
remove_role( 'qd_admin' );
$admin = get_role( 'administrator' );
if ( $admin ) {
	$admin->remove_cap( 'qd_manage' );
	$admin->remove_cap( 'qd_facilitate' );
}
