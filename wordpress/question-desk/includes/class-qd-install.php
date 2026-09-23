<?php
/**
 * Activation: custom tables, roles and capabilities, and the rewrite rule for the public pages.
 *
 * Tables replace the Apps Script version's Script Properties and sheets (see WORDPRESS.md).
 * Capabilities: qd_manage (administrators: everything) and qd_facilitate (the QA Facilitator
 * role, and administrators: run the queue for their sessions).
 */

defined( 'ABSPATH' ) || exit;

class QD_Install {

	const DB_VERSION = '2';

	public static function activate() {
		QD_Schedule::schedule();
		self::create_tables();
		self::add_roles();
		update_option( 'qd_db_version', self::DB_VERSION );
		QD_Router::add_rules();
		flush_rewrite_rules();
	}

	public static function deactivate() {
		QD_Schedule::unschedule();
		flush_rewrite_rules();
	}

	/** Runs the table and role setup again after an update that changed them. */
	public static function maybe_upgrade() {
		if ( get_option( 'qd_db_version' ) !== self::DB_VERSION ) {
			self::create_tables();
			self::add_roles();
			update_option( 'qd_db_version', self::DB_VERSION );
		}
	}

	/** The table name for one of: events, sessions, questions, topics, votes, activity, archive. */
	public static function table( $name ) {
		global $wpdb;
		return $wpdb->prefix . 'qd_' . $name;
	}

	public static function create_tables() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();

		// dbDelta is particular: two spaces after PRIMARY KEY, one field per line.
		$sql = array(
			'CREATE TABLE ' . self::table( 'events' ) . " (
  id char(8) NOT NULL,
  name varchar(200) NOT NULL DEFAULT '',
  sort int NOT NULL DEFAULT 0,
  data longtext NOT NULL,
  created bigint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id)
) $charset;",
			'CREATE TABLE ' . self::table( 'sessions' ) . " (
  id char(8) NOT NULL,
  event_id char(8) NOT NULL DEFAULT '',
  name varchar(200) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'inactive',
  sort int NOT NULL DEFAULT 0,
  data longtext NOT NULL,
  created bigint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id),
  KEY event_id (event_id),
  KEY status (status)
) $charset;",
			'CREATE TABLE ' . self::table( 'questions' ) . " (
  id char(8) NOT NULL,
  session_id char(8) NOT NULL,
  submitted bigint unsigned NOT NULL DEFAULT 0,
  device varchar(64) NOT NULL DEFAULT '',
  text text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'new',
  topic varchar(200) NOT NULL DEFAULT '',
  lang varchar(60) NOT NULL DEFAULT '',
  translation text NOT NULL,
  grouping varchar(20) NOT NULL DEFAULT '',
  translations text NOT NULL,
  logistics varchar(10) NOT NULL DEFAULT '',
  PRIMARY KEY  (id),
  KEY session_status (session_id,status),
  KEY session_topic (session_id,topic(100))
) $charset;",
			'CREATE TABLE ' . self::table( 'topics' ) . " (
  session_id char(8) NOT NULL,
  topic varchar(200) NOT NULL,
  merged text NOT NULL,
  labels text NOT NULL,
  merged_labels text NOT NULL,
  shown tinyint(1) NOT NULL DEFAULT 0,
  updated bigint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (session_id,topic(150))
) $charset;",
			'CREATE TABLE ' . self::table( 'votes' ) . " (
  session_id char(8) NOT NULL,
  vote_key varchar(200) NOT NULL,
  votes int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (session_id,vote_key(150))
) $charset;",
			'CREATE TABLE ' . self::table( 'activity' ) . " (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  at bigint unsigned NOT NULL DEFAULT 0,
  who varchar(200) NOT NULL DEFAULT '',
  action varchar(200) NOT NULL DEFAULT '',
  target varchar(250) NOT NULL DEFAULT '',
  target_id char(8) NOT NULL DEFAULT '',
  details text NOT NULL,
  PRIMARY KEY  (id),
  KEY at (at),
  KEY target_id (target_id)
) $charset;",
			'CREATE TABLE ' . self::table( 'archive' ) . " (
  session_id char(8) NOT NULL,
  archived bigint unsigned NOT NULL DEFAULT 0,
  session longtext NOT NULL,
  votes longtext NOT NULL,
  PRIMARY KEY  (session_id)
) $charset;",
		);
		dbDelta( $sql );
	}

	public static function add_roles() {
		if ( ! get_role( 'qd_facilitator' ) ) {
			add_role( 'qd_facilitator', 'QA Facilitator', array( 'read' => true, 'qd_facilitate' => true ) );
		}
		// Sees the questions about running an event, for the events they are assigned to.
		if ( ! get_role( 'qd_coordinator' ) ) {
			add_role( 'qd_coordinator', 'Event Coordinator', array( 'read' => true, 'qd_coordinate' => true ) );
		}
		// Manages Question Desk without being a WordPress administrator.
		if ( ! get_role( 'qd_admin' ) ) {
			add_role( 'qd_admin', 'Question Desk Admin', array( 'read' => true, 'qd_manage' => true, 'qd_facilitate' => true, 'qd_coordinate' => true, 'upload_files' => true ) );
		}
		$admin = get_role( QD_App::t( 'admin.roleAdministrator' ) );
		if ( $admin ) {
			$admin->add_cap( 'qd_manage' );
			$admin->add_cap( 'qd_facilitate' );
			$admin->add_cap( 'qd_coordinate' );
		}
	}
}
