<?php
/**
 * The server functions pages call through google.script.run, as one REST route:
 * POST /wp-json/question-desk/v1/call/{function}  body: {"args": [...]}
 * Answer: {"ok": true, "value": …} or {"ok": false, "error": "…"} (the page's failure handler).
 *
 * Every function is registered with who may call it: 'public' (anyone, like participant calls
 * in the Apps Script version), 'facilitate' or 'manage'. Functions check finer rules themselves
 * (this session's QA Facilitators, for one). Anything not registered doesn't exist.
 */

defined( 'ABSPATH' ) || exit;

class QD_Api {

	/** @var array<string, array{0: callable, 1: string}> */
	private static $functions = array();

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * @param string   $name     The name pages use, e.g. 'getSessionState'.
	 * @param callable $callback Receives the call's arguments.
	 * @param string   $access   'public', 'facilitate' or 'manage'.
	 */
	public static function register( $name, $callback, $access ) {
		self::$functions[ $name ] = array( $callback, $access );
	}

	public static function registered() {
		return self::$functions;
	}

	public static function register_routes() {
		register_rest_route(
			'question-desk/v1',
			'/call/(?P<fn>[A-Za-z]+)',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle' ),
				'permission_callback' => '__return_true',   // checked per function in call()
			)
		);
	}

	public static function handle( WP_REST_Request $request ) {
		$args     = $request->get_json_params();
		$args     = is_array( $args ) && isset( $args['args'] ) && is_array( $args['args'] ) ? array_values( $args['args'] ) : array();
		$response = self::call( (string) $request['fn'], $args );
		$rest     = rest_ensure_response( $response );
		$rest->header( 'Cache-Control', 'no-store' );   // a page cache must never answer for the server
		return $rest;
	}

	/** Runs one registered function for the current user. */
	public static function call( $name, array $args ) {
		if ( ! isset( self::$functions[ $name ] ) ) {
			return array( 'ok' => false, 'error' => 'Unknown function ' . $name . '.' );
		}
		list( $callback, $access ) = self::$functions[ $name ];
		if ( 'manage' === $access && ! current_user_can( 'qd_manage' ) ) {
			return array( 'ok' => false, 'error' => 'Only administrators can do that.' );
		}
		if ( 'facilitate' === $access && ! current_user_can( 'qd_facilitate' ) ) {
			return array( 'ok' => false, 'error' => 'Sign in as a QA Facilitator or administrator to do that.' );
		}
		try {
			return array( 'ok' => true, 'value' => call_user_func_array( $callback, $args ) );
		} catch ( QD_Error $e ) {
			return array( 'ok' => false, 'error' => $e->getMessage() );
		} catch ( Throwable $e ) {
			error_log( 'Question Desk ' . $name . ': ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			return array( 'ok' => false, 'error' => 'Something went wrong. Try again.' );
		}
	}
}
