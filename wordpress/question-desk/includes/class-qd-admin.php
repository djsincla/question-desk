<?php
/**
 * The Admin page: the state it draws from, its place in the WordPress admin menu, and the
 * server functions it calls (admin.js in the Apps Script version).

 */

defined( 'ABSPATH' ) || exit;

class QD_Admin {

	const MENU_SLUG = 'question-desk';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_menu' ) );
		add_action( 'admin_post_qd_admin_page', array( __CLASS__, 'serve_page' ) );
		self::register_functions();
	}

	// ------------------------------------------------------------ state

	/** Everything the Admin page draws, the same shape as adminState(). */
	public static function state() {
		$me       = QD_People::require_admin();
		$counts   = QD_Questions::counts();
		$prepared = QD_Questions::prepared();
		$config   = QD_App::data()['config'];

		$sessions = array_map(
			function ( $s ) use ( $counts, $prepared ) {
				$s['links']         = QD_Sessions::links( $s );
				$s['guestPage']     = QD_Sessions::guest_choice( $s['guestPage'] ?? null );
				$s['questionCount'] = (int) ( $counts[ $s['id'] ] ?? 0 );
				$s['prepared']      = $prepared[ $s['id'] ] ?? array();
				$s['summaryTo']     = QD_Settings::summary_recipients( $s );
				return $s;
			},
			QD_Store::all_sessions()
		);

		$languages = array();
		foreach ( (array) $config['languages'] as $code => $lang ) {
			$languages[] = array( 'code' => $code, 'name' => $lang['name'], 'native' => $lang['native'] );
		}

		return array(
			'me'               => $me,
			'owner'            => QD_People::owner_email(),
			'domain'           => '',   // WordPress users, so no domain restriction
			'admins'           => QD_People::admins(),
			'moderators'       => QD_People::moderators(),
			'sessions'         => $sessions,
			'events'           => QD_Store::all_events(),
			'languages'        => $languages,
			'siteLanguages'    => QD_Settings::site_languages(),
			'maxLanguages'     => $config['maxLanguages'],
			'archived'         => QD_Sessions::archived(),
			'brand'            => QD_Brand::site(),
			'summaryDefaults'  => QD_Settings::summary_defaults(),
			'publicUrl'        => QD_Router::base_url(),
			'guestPageUrl'     => '',   // not needed: WordPress serves the pages itself
			'guestPageDefault' => '',
			'detectedUrl'      => QD_Router::base_url(),
			'appUrl'           => QD_Router::base_url(),
			'ops'              => self::ops(),
			'gemini'           => self::gemini_settings(),
			'geminiDefaults'   => self::gemini_defaults(),
			'storage'          => array( 'bytes' => 0, 'limit' => 0, 'percent' => 0 ),
			'geminiKeySet'     => (bool) self::gemini_key(),
			'sheetUrl'         => admin_url( 'admin.php?page=' . self::MENU_SLUG ),
			'mailQuota'        => 0,   // WordPress has no daily quota of its own
			'health'           => (array) get_option( 'qd_health', array() ),
			'loadTest'         => QD_Operations::load_test_view(),
			'limits'           => array(
				'maxLengthCeiling' => $config['maxLengthCeiling'],
				'defaultMaxLength' => $config['defaultMaxLength'],
				'cooldownSeconds'  => $config['cooldownSeconds'],
				'cooldownCeiling'  => $config['cooldownCeiling'],
			),
			'app'              => array(
				'version'      => QD_VERSION,
				'releaseNotes' => 'https://github.com/djsincla/question-desk/releases',
				'repo'         => 'https://github.com/djsincla/question-desk',
			),
		);
	}

	/** Retention and the weekly report; the settings are read now and acted on in phase 5. */
	public static function ops() {
		$saved = (array) get_option( 'qd_ops', array() );
		return array(
			'retentionMonths' => isset( $saved['retentionMonths'] ) ? (int) $saved['retentionMonths'] : 0,
			'weeklyReport'    => ! empty( $saved['weeklyReport'] ),
		);
	}

	public static function gemini_defaults() {
		$config = QD_App::data()['config'];
		return array(
			'model'       => $config['model'],
			'thinking'    => array( 'grouping' => 'default', 'merging' => 'low', 'translating' => 'low' ),
			'temperature' => 0.1,
			'batchSize'   => $config['clusterBatchSize'],
		);
	}

	/** Saved Gemini options over the defaults (phase 4 saves them; the page only reads here). */
	public static function gemini_settings() {
		$defaults = self::gemini_defaults();
		$saved    = (array) get_option( 'qd_gemini', array() );
		$thinking = array();
		foreach ( $defaults['thinking'] as $task => $level ) {
			$want              = $saved['thinking'][ $task ] ?? '';
			$thinking[ $task ] = in_array( $want, array( 'default', 'minimal', 'low', 'medium', 'high' ), true ) ? $want : $level;
		}
		$temperature = isset( $saved['temperature'] ) ? (float) $saved['temperature'] : null;
		$batch       = isset( $saved['batchSize'] ) ? (int) $saved['batchSize'] : 0;
		return array(
			'model'       => ( isset( $saved['model'] ) && preg_match( '/^gemini-[a-z0-9][a-z0-9.-]{0,60}$/', (string) $saved['model'] ) ) ? $saved['model'] : $defaults['model'],
			'thinking'    => $thinking,
			'temperature' => ( null !== $temperature && $temperature >= 0 && $temperature <= 1 ) ? $temperature : $defaults['temperature'],
			'batchSize'   => ( $batch >= 1 && $batch <= 100 ) ? $batch : $defaults['batchSize'],
		);
	}

	/** The Gemini key: a constant in wp-config.php wins over the stored one. */
	public static function gemini_key() {
		if ( defined( 'QD_GEMINI_API_KEY' ) && QD_GEMINI_API_KEY ) {
			return (string) QD_GEMINI_API_KEY;
		}
		return (string) get_option( 'qd_gemini_key', '' );
	}

	// ------------------------------------------------------------ the page in wp-admin

	public static function add_menu() {
		add_menu_page(
			'Question Desk',
			'Question Desk',
			'qd_manage',
			self::MENU_SLUG,
			array( __CLASS__, 'render_page' ),
			'dashicons-microphone',
			30
		);
	}

	/**
	 * The same Admin.html every version uses, inside the WordPress admin area. It is a whole
	 * page, so it goes in a frame of its own rather than fighting the admin stylesheet.
	 */
	public static function render_page() {
		$src = add_query_arg( 'qd_admin', wp_create_nonce( 'qd_admin' ), admin_url( 'admin-post.php?action=qd_admin_page' ) );
		echo '<div class="wrap" style="margin:0;padding:0">';
		echo '<iframe title="Question Desk" src="' . esc_url( $src ) . '" style="width:100%;height:calc(100vh - 32px);border:0;display:block"></iframe>';
		echo '</div>';
	}

	/** Serves Admin.html itself for that frame. */
	public static function serve_page() {
		if ( ! current_user_can( 'qd_manage' ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_GET['qd_admin'] ?? '' ) ), 'qd_admin' ) ) {
			wp_die( 'Not allowed.', '', array( 'response' => 403 ) );
		}
		QD_Pages::send( 'Admin.html', 'Question Desk — Admin', array(
			'state'   => self::state(),
			'version' => QD_VERSION,
		) );
	}

	// ------------------------------------------------------------ what the page may call

	private static function register_functions() {
		$manage = array(
			'adminState'          => function () {
				return self::state();
			},
			'saveSession'         => array( 'QD_Sessions', 'save' ),
			'reorderSessions'     => array( 'QD_Sessions', 'reorder' ),
			'setSessionActive'    => array( 'QD_Sessions', 'set_active' ),
			'regenerateLink'      => array( 'QD_Sessions', 'regenerate_link' ),
			'endSession'          => array( 'QD_Sessions', 'end' ),
			'deleteSession'       => array( 'QD_Sessions', 'delete' ),
			'duplicateSession'    => array( 'QD_Sessions', 'duplicate' ),
			'archiveSession'      => array( 'QD_Sessions', 'archive' ),
			'restoreSession'      => array( 'QD_Sessions', 'restore' ),
			'saveEvent'           => array( 'QD_Events', 'save' ),
			'reorderEvents'       => array( 'QD_Events', 'reorder' ),
			'deleteEvent'         => array( 'QD_Events', 'delete' ),
			'duplicateEvent'      => array( 'QD_Events', 'duplicate' ),
			'saveEventLogo'       => array( 'QD_Events', 'save_logo' ),
			'removeEventLogo'     => array( 'QD_Events', 'remove_logo' ),
			'getEventLogo'        => array( 'QD_Events', 'get_logo' ),
			'saveBrand'           => array( 'QD_Settings', 'save_brand' ),
			'saveSiteLanguages'   => array( 'QD_Settings', 'save_site_languages' ),
			'saveSummaryDefaults' => array( 'QD_Settings', 'save_summary_defaults' ),
			'saveLogo'            => array( __CLASS__, 'save_logo' ),
			'removeLogo'          => array( __CLASS__, 'remove_logo' ),
			'getSessionLogo'      => array( __CLASS__, 'session_logo' ),
			'addPerson'           => array( 'QD_People', 'add_person' ),
			'removePerson'        => array( 'QD_People', 'remove_person' ),
		);
		foreach ( $manage as $name => $callback ) {
			QD_Api::register( $name, $callback, 'manage' );
		}
	}

	/** saveLogo(dataUrl, sid): no session id means the site logo. */
	public static function save_logo( $data_url, $sid = '' ) {
		QD_People::require_admin();
		if ( $sid && ! QD_Store::get_session( $sid ) ) {
			throw new QD_Error( 'Session not found.' );
		}
		return QD_Settings::save_logo( $data_url, (string) $sid );   // logs the change itself
	}

	public static function remove_logo( $sid = '' ) {
		return QD_Settings::remove_logo( (string) $sid );
	}

	public static function session_logo( $sid ) {
		QD_People::require_admin();
		return QD_Settings::logo_url( (string) $sid );
	}
}
