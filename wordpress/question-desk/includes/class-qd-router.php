<?php
/**
 * The public pages live under one address, /questions/ by default, with the same parameters as
 * the Apps Script version: ?s=…&t=… (ask), ?view=present, ?view=moderate, ?view=panel,
 * ?view=qrsheet. Admin is a WordPress admin page.
 */

defined( 'ABSPATH' ) || exit;

class QD_Router {

	public static function init() {
		add_action( 'init', array( __CLASS__, 'add_rules' ) );
		add_filter( 'query_vars', array( __CLASS__, 'query_vars' ) );
		add_action( 'template_redirect', array( __CLASS__, 'maybe_render' ) );
	}

	public static function slug() {
		$slug = sanitize_title( (string) get_option( 'qd_slug', 'questions' ) );
		return '' === $slug ? 'questions' : $slug;
	}

	/** The base address of the public pages, e.g. https://example.org/questions/ */
	public static function base_url() {
		return home_url( '/' . self::slug() . '/' );
	}

	public static function add_rules() {
		add_rewrite_rule( '^' . preg_quote( self::slug(), '/' ) . '/?$', 'index.php?qd_page=1', 'top' );
	}

	public static function query_vars( $vars ) {
		$vars[] = 'qd_page';
		return $vars;
	}

	public static function maybe_render() {
		if ( ! get_query_var( 'qd_page' ) ) {
			return;
		}
		$params = array();
		foreach ( array( 'view', 's', 't', 'k', 'r', 'layout', 'e', 'lang' ) as $name ) {
			if ( isset( $_GET[ $name ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- public page parameters, like doGet
				$params[ $name ] = sanitize_text_field( wp_unslash( $_GET[ $name ] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			}
		}
		self::dispatch( $params );
	}

	/** doGet: which page to show for these parameters. */
	public static function dispatch( array $p ) {
		$view = $p['view'] ?? 'ask';
		if ( 'ask' === $view && empty( $p['s'] ) ) {
			self::home();
		}
		// Later phases: ask, present, panel, moderate, qrsheet.
		QD_Pages::send( 'Denied.html', 'Not available yet', array(
			'heading' => 'This page isn\'t available yet',
			'body'    => 'The WordPress version of Question Desk is still being built.',
			'links'   => array(),
		) );
	}

	/** The landing page: how to join, and staff links when signed in. */
	public static function home() {
		$user   = wp_get_current_user();
		$admin  = current_user_can( 'qd_manage' );
		$staff  = $admin || current_user_can( 'qd_facilitate' );
		$brand  = QD_Brand::site();
		$title  = $brand['orgName'] ? $brand['orgName'] . ' — Question Desk' : 'Question Desk';
		QD_Pages::send( 'Home.html', $title, array(
			'languages' => array_values( (array) get_option( 'qd_languages', QD_App::config( 'defaultLanguages' ) ) ),
			'version'   => QD_VERSION,
			'signedIn'  => $user->exists(),
			'staff'     => $staff,
			'adminUrl'  => $admin ? admin_url( 'admin.php?page=question-desk' ) : '',
			'domain'    => '',
			'signInUrl' => wp_login_url( self::base_url() ),
			'sessions'  => array(),
		) );
	}
}
