<?php
/**
 * Keeping an installation healthy: retention, the weekly report, the health check, the Gemini
 * settings and the load test (operations.js and the Gemini settings in gemini.js).
 */

defined( 'ABSPATH' ) || exit;

class QD_Operations {

	public static function init() {
		QD_Api::register( 'saveOpsSettings', array( __CLASS__, 'save_ops' ), 'manage' );
		QD_Api::register( 'sendWeeklyReportNow', array( __CLASS__, 'send_weekly_now' ), 'manage' );
		QD_Api::register( 'runHealthCheck', array( __CLASS__, 'health_check' ), 'manage' );
		QD_Api::register( 'getActivity', array( 'QD_Activity', 'get' ), 'manage' );
		QD_Api::register( 'saveGeminiSettings', array( __CLASS__, 'save_gemini' ), 'manage' );
		QD_Api::register( 'testGeminiSettings', array( __CLASS__, 'test_gemini' ), 'manage' );
		QD_Api::register( 'listGeminiModels', array( __CLASS__, 'list_models' ), 'manage' );
		QD_Api::register( 'startLoadTest', array( __CLASS__, 'start_load_test' ), 'manage' );
		QD_Api::register( 'stopLoadTest', array( __CLASS__, 'stop_load_test' ), 'manage' );
		// The load-test endpoint: harmless unless an administrator started one, and only this
		// path skips the per-session cap.
		QD_Api::register( 'loadTestSubmit', array( __CLASS__, 'load_test_submit' ), 'public' );
		QD_Api::register( 'loadTestCount', array( __CLASS__, 'load_test_count' ), 'public' );
	}

	// ------------------------------------------------------------ settings

	public static function save_ops( $input = array() ) {
		QD_People::require_admin();
		$input  = (array) $input;
		$months = (int) round( (float) ( $input['retentionMonths'] ?? 0 ) );
		if ( $months < 0 || $months > 120 ) {
			throw new QD_Error( 'Keep question wording for between 0 and 120 months.' );
		}
		$saved = array( 'retentionMonths' => $months, 'weeklyReport' => ! empty( $input['weeklyReport'] ) );
		update_option( 'qd_ops', $saved, false );
		QD_Activity::log( 'Data and reports settings changed', null,
			( $months ? 'wording removed after ' . $months . ' months' : 'wording kept' )
			. ', weekly report ' . ( $saved['weeklyReport'] ? 'on' : 'off' ) );
		return QD_Admin::state();
	}

	/** The wording taken out of old questions, so the sentence says why. */
	public static function removed_text( $months ) {
		return '[wording removed after ' . $months . ' months]';
	}

	/**
	 * Replaces question wording, translations and read-out questions for sessions that ended
	 * more than the retention period ago (applyRetention_). The rows stay, so counts and
	 * topics still make sense.
	 */
	public static function apply_retention() {
		global $wpdb;
		$months = (int) self::ops()['retentionMonths'];
		if ( ! $months ) {
			return array( 'questions' => 0 );
		}
		$cutoff = QD_Util::now_ms() - (int) round( $months * 30.44 * 24 * 3600 * 1000 );
		$old    = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( 'ended' === $s['status'] && ! empty( $s['ended'] ) && $s['ended'] < $cutoff ) {
				$old[] = $s['id'];
			}
		}
		foreach ( QD_Sessions::archived() as $a ) {
			if ( ! empty( $a['ended'] ) && $a['ended'] < $cutoff ) {
				$old[] = $a['id'];
			}
		}
		if ( ! $old ) {
			return array( 'questions' => 0 );
		}
		$marker    = self::removed_text( $months );
		$marks     = implode( ',', array_fill( 0, count( $old ), '%s' ) );
		$questions = QD_Install::table( 'questions' );
		$topics    = QD_Install::table( 'topics' );
		$changed   = (int) $wpdb->query( $wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQL
			"UPDATE $questions SET text = %s, translation = CASE WHEN translation = '' THEN '' ELSE %s END, translations = ''
			 WHERE session_id IN ($marks) AND text NOT LIKE '[wording removed%'",
			array_merge( array( $marker, $marker ), $old )
		) );
		$merged = (int) $wpdb->query( $wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQL
			"UPDATE $topics SET merged = %s, merged_labels = '' WHERE session_id IN ($marks) AND merged <> '' AND merged NOT LIKE '[wording removed%'",
			array_merge( array( $marker ), $old )
		) );
		// Quoted wording in the activity log goes too.
		$activity = QD_Install::table( 'activity' );
		$log      = (int) $wpdb->query( $wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQL
			"UPDATE $activity SET details = %s WHERE target_id IN ($marks) AND details LIKE '\"%'",
			array_merge( array( $marker ), $old )
		) );
		foreach ( $old as $sid ) {
			QD_Cache::invalidate( $sid );
		}
		if ( $changed || $merged ) {
			QD_Activity::log( 'Question wording removed', null, $changed . ' questions in ' . count( $old )
				. ' sessions ended over ' . $months . ' months ago' );
		}
		return array( 'questions' => $changed, 'merged' => $merged, 'log' => $log, 'sessions' => count( $old ) );
	}

	public static function ops() {
		return QD_Admin::ops();
	}

	// ------------------------------------------------------------ the weekly report

	/** What the weekly report says (weeklyReport_). */
	public static function weekly_report() {
		$now      = QD_Util::now_ms();
		$week     = 7 * 24 * 3600 * 1000;
		$health   = (array) get_option( 'qd_health', array() );
		$cron     = (bool) wp_next_scheduled( QD_Schedule::MINUTE_HOOK );
		$sessions = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( empty( $s['loadTest'] ) ) {
				$sessions[] = $s;
			}
		}
		$label    = function ( $s ) {
			$event = QD_Store::event_name( $s );
			return ( $event ? $event . ' — ' : '' ) . $s['name'];
		};
		$upcoming = array();
		$active   = array();
		$ended    = array();
		$owed     = array();
		foreach ( $sessions as $s ) {
			if ( 'ended' !== $s['status'] && ! empty( $s['scheduledStart'] ) && $s['scheduledStart'] > $now && $s['scheduledStart'] < $now + $week ) {
				$upcoming[] = $s;
			}
			if ( 'active' === $s['status'] ) {
				$active[] = $label( $s );
			}
			if ( 'ended' === $s['status'] && ! empty( $s['ended'] ) && $s['ended'] > $now - $week ) {
				$ended[] = $label( $s );
			}
			if ( ! empty( $s['summaryPending'] ) && empty( $s['summarySent'] ) ) {
				$owed[] = $label( $s );
			}
		}
		usort( $upcoming, function ( $a, $b ) {
			return $a['scheduledStart'] <=> $b['scheduledStart'];
		} );

		global $wpdb;
		$asked = (int) $wpdb->get_var( $wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
			'SELECT COUNT(*) FROM ' . QD_Install::table( 'questions' ) . " WHERE status <> 'prepared' AND submitted > %d",
			$now - $week
		) );
		$ops    = self::ops();
		$checks = array(
			array(
				'name'   => 'Question grouping',
				'ok'     => empty( $health['failures'] ) && $cron,
				'detail' => ! $cron ? 'The every-minute run is not scheduled — deactivate and activate the plugin.'
					: ( ! empty( $health['failures'] ) ? $health['failures'] . ' failed runs in a row: ' . ( $health['lastError'] ?? '' ) : 'Working' ),
			),
			array( 'name' => 'Gemini API key', 'ok' => (bool) QD_Gemini::key(), 'detail' => QD_Gemini::key() ? 'Set' : 'Missing' ),
			array( 'name' => 'Questions stored', 'ok' => true,
				'detail' => (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . QD_Install::table( 'questions' ) ) . ' in the database' ), // phpcs:ignore WordPress.DB.PreparedSQL
		);
		if ( $owed ) {
			$checks[] = array( 'name' => 'Summaries not sent', 'ok' => false, 'detail' => implode( ', ', $owed ) );
		}
		$when = array();
		foreach ( $upcoming as $s ) {
			$when[] = $label( $s ) . ' — ' . wp_date( 'D M j, g:i a', (int) round( $s['scheduledStart'] / 1000 ) );
		}
		return array(
			'checks'    => $checks,
			'upcoming'  => $when,
			'active'    => $active,
			'ended'     => $ended,
			'asked'     => $asked,
			'retention' => $ops['retentionMonths']
				? 'Question wording is removed ' . $ops['retentionMonths'] . ' months after a session ends.'
				: 'Question wording is kept.',
		);
	}

	public static function send_weekly_report( $only_to = '' ) {
		$report = self::weekly_report();
		$to     = $only_to ? array( $only_to ) : QD_People::admins();
		if ( ! $to ) {
			return 0;
		}
		$list = function ( $title, $items, $empty ) {
			$html = '<h2 style="font-size:15px;margin:20px 0 6px">' . esc_html( $title ) . '</h2>';
			if ( ! $items ) {
				return $html . '<p style="color:#5c6874;margin:0">' . esc_html( $empty ) . '</p>';
			}
			$html .= '<ul style="margin:0;padding-left:20px">';
			foreach ( $items as $item ) {
				$html .= '<li>' . esc_html( $item ) . '</li>';
			}
			return $html . '</ul>';
		};
		$problems = 0;
		$table    = '<table style="border-collapse:collapse;width:100%">';
		foreach ( $report['checks'] as $check ) {
			if ( ! $check['ok'] ) {
				$problems++;
			}
			$table .= '<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e6eb;font-weight:700;color:'
				. ( $check['ok'] ? '#2e7d5b' : '#a3321f' ) . '">' . ( $check['ok'] ? '✓' : '✗' ) . '</td>'
				. '<td style="padding:6px 8px;border-bottom:1px solid #e2e6eb">' . esc_html( $check['name'] ) . '</td>'
				. '<td style="padding:6px 8px;border-bottom:1px solid #e2e6eb;color:#5c6874">' . esc_html( $check['detail'] ) . '</td></tr>';
		}
		$table .= '</table>';
		$html   = '<p style="margin:0 0 12px">' . ( $problems
			? '<strong>' . $problems . ' thing' . ( 1 === $problems ? '' : 's' ) . ' need attention.</strong>'
			: 'Everything looks healthy.' ) . '</p>' . $table
			. $list( 'Coming up in the next 7 days', $report['upcoming'], 'Nothing scheduled.' )
			. $list( 'Active now', $report['active'], 'No sessions are active.' )
			. $list( 'Ended in the last 7 days', $report['ended'], 'None.' )
			. '<p style="margin:20px 0 0;color:#5c6874">' . $report['asked'] . ' questions asked in the last 7 days. '
			. esc_html( $report['retention'] ) . '</p>'
			. '<p style="margin:8px 0 0;color:#5c6874;font-size:13px">Turn this report off on the Admin page → Health &amp; testing.</p>';

		$brand = QD_Brand::site();
		$sent  = 0;
		foreach ( $to as $address ) {
			if ( QD_Summaries::mail( $address, 'Question Desk — weekly report', QD_Summaries::shell( $brand, 'Weekly report', $html ), $brand ) ) {
				$sent++;
			}
		}
		update_option( 'qd_weekly_sent', QD_Util::now_ms(), false );
		return $sent;
	}

	public static function send_weekly_now() {
		$me   = QD_People::require_admin();
		$sent = self::send_weekly_report( $me );
		QD_Activity::log( 'Weekly report sent by hand', null, $me );
		return array( 'emailed' => $sent );
	}

	/** Mondays after 8 a.m. in the site's time zone, at most once a week (weeklyReportDue_). */
	public static function weekly_report_due() {
		if ( empty( self::ops()['weeklyReport'] ) ) {
			return false;
		}
		$now = (int) ( QD_Util::now_ms() / 1000 );
		if ( 'Mon' !== wp_date( 'D', $now ) || (int) wp_date( 'G', $now ) < 8 ) {
			return false;
		}
		$last = (int) get_option( 'qd_weekly_sent', 0 );
		return ! $last || QD_Util::now_ms() - $last > 6 * 24 * 3600 * 1000;
	}

	// ------------------------------------------------------------ health

	public static function health_check() {
		QD_People::require_admin();
		$checks = array();
		$add    = function ( $name, $ok, $detail ) use ( &$checks ) {
			$checks[] = array( 'name' => $name, 'ok' => (bool) $ok, 'detail' => $detail );
		};
		$key = QD_Gemini::key();
		$add( 'Gemini API key', $key, $key ? ( defined( 'QD_GEMINI_API_KEY' ) ? 'Set in wp-config.php' : 'Set' )
			: 'Missing — add it under Admin → Health, or as QD_GEMINI_API_KEY in wp-config.php.' );
		if ( $key ) {
			$started = QD_Util::now_ms();
			$r       = QD_Gemini::request( 'Health check. Set ok to true.',
				array( 'type' => 'OBJECT', 'properties' => array( 'ok' => array( 'type' => 'BOOLEAN' ) ), 'required' => array( 'ok' ) ),
				array( 'task' => 'grouping' ) );
			$add( 'Gemini model ' . QD_Admin::gemini_settings()['model'], ! empty( $r['ok'] ),
				! empty( $r['ok'] ) ? 'Responded in ' . ( QD_Util::now_ms() - $started ) . ' ms' : ( $r['error'] ?? '' ) );
		}
		$next = wp_next_scheduled( QD_Schedule::MINUTE_HOOK );
		$add( 'Grouping and schedule run', (bool) $next, $next
			? ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON
				? 'Scheduled, but WP-Cron is disabled: the host must call wp-cron.php every minute.'
				: 'Scheduled; WordPress runs it when the site gets traffic. A real cron on the host is steadier.' )
			: 'Not scheduled — deactivate and activate Question Desk.' );

		global $wpdb;
		$tables = array( 'sessions', 'questions', 'topics', 'votes', 'activity', 'archive', 'events' );
		$found  = 0;
		foreach ( $tables as $name ) {
			$table = QD_Install::table( $name );
			if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) === $table ) { // phpcs:ignore WordPress.DB.PreparedSQL
				$found++;
			}
		}
		$add( 'Database tables', $found === count( $tables ), $found . ' of ' . count( $tables ) . ' present' );
		$add( 'Email', true, 'WordPress sends with ' . ( has_action( 'phpmailer_init' ) ? 'a mail plugin' : 'PHP mail(), which many hosts drop — an SMTP plugin is safer' ) );

		$url      = QD_Router::base_url();
		$response = wp_remote_get( $url, array( 'timeout' => 15 ) );
		$code     = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
		$add( 'Public pages', 200 === $code, 200 === $code ? $url
			: ( is_wp_error( $response ) ? $response->get_error_message() : 'Answered ' . $code . ' at ' . $url ) );
		QD_Activity::log( 'Health check run', null, '' );
		return array( 'checks' => $checks, 'at' => QD_Util::now_ms() );
	}

	// ------------------------------------------------------------ Gemini settings

	public static function save_gemini( $input = array() ) {
		QD_People::require_admin();
		$input = (array) $input;
		$next  = ! empty( $input['reset'] ) ? QD_Admin::gemini_defaults() : self::clean_gemini( $input );
		update_option( 'qd_gemini', $next, false );
		if ( array_key_exists( 'apiKey', $input ) && ! defined( 'QD_GEMINI_API_KEY' ) ) {
			$key = trim( (string) $input['apiKey'] );
			if ( $key ) {
				update_option( 'qd_gemini_key', $key, false );
			}
		}
		QD_Activity::log( ! empty( $input['reset'] ) ? 'Gemini settings reset' : 'Gemini settings changed', null,
			$next['model'] . ' · thinking: grouping ' . $next['thinking']['grouping'] . ', merging ' . $next['thinking']['merging']
			. ', translating ' . $next['thinking']['translating'] . ' · temperature ' . $next['temperature']
			. ' · ' . $next['batchSize'] . ' questions per request' );
		return QD_Admin::state();
	}

	private static function clean_gemini( array $input ) {
		$model = (string) ( $input['model'] ?? '' );
		if ( ! preg_match( '/^gemini-[a-z0-9][a-z0-9.-]{0,60}$/', $model ) ) {
			throw new QD_Error( 'That model name does not look like a Gemini model.' );
		}
		$thinking = array();
		foreach ( QD_Gemini::TASKS as $task ) {
			$level = $input['thinking'][ $task ] ?? '';
			if ( ! in_array( $level, QD_Gemini::THINKING, true ) ) {
				throw new QD_Error( 'Choose a thinking level for ' . $task . '.' );
			}
			$thinking[ $task ] = $level;
		}
		$temperature = (float) ( $input['temperature'] ?? -1 );
		if ( ! ( $temperature >= 0 && $temperature <= 1 ) ) {
			throw new QD_Error( 'Temperature must be between 0 and 1.' );
		}
		$batch = (float) ( $input['batchSize'] ?? 0 );
		if ( $batch < 5 || $batch > 100 || floor( $batch ) !== $batch ) {
			throw new QD_Error( 'Questions per grouping request must be a whole number from 5 to 100.' );
		}
		return array( 'model' => $model, 'thinking' => $thinking,
			'temperature' => round( $temperature * 100 ) / 100, 'batchSize' => (int) $batch );
	}

	/** Tries settings before saving them: one small request per thinking level, timed. */
	public static function test_gemini( $input = array() ) {
		QD_People::require_admin();
		$settings = self::clean_gemini( (array) $input );
		$schema   = array( 'type' => 'OBJECT', 'properties' => array( 'question' => array( 'type' => 'STRING' ) ), 'required' => array( 'question' ) );
		$prompt   = "Write one question that covers these audience questions, under 20 words:\n"
			. "- Will respite care hours be cut next year?\n- How are families consulted before respite hours change?";
		$seen     = array();
		$results  = array();
		foreach ( QD_Gemini::TASKS as $task ) {
			$level = $settings['thinking'][ $task ];
			if ( isset( $seen[ $level ] ) ) {
				$results[] = array_merge( $seen[ $level ], array( 'task' => $task ) );
				continue;
			}
			$started = QD_Util::now_ms();
			$r       = QD_Gemini::request( $prompt, $schema, array( 'settings' => $settings, 'thinking' => $level ) );
			$result  = array(
				'task'     => $task,
				'thinking' => $level,
				'ok'       => ! empty( $r['ok'] ) && ! empty( $r['data']['question'] ),
				'ms'       => QD_Util::now_ms() - $started,
				'retried'  => ! empty( $r['retriedWithoutThinking'] ),
				'error'    => empty( $r['ok'] ) ? ( $r['error'] ?? '' ) : '',
			);
			$seen[ $level ] = $result;
			$results[]      = $result;
		}
		return array( 'model' => $settings['model'], 'results' => $results );
	}

	/** The Gemini models this key may use, for the Admin page's list. */
	public static function list_models() {
		QD_People::require_admin();
		$key = QD_Gemini::key();
		if ( ! $key ) {
			return array( 'ok' => false, 'error' => 'No Gemini API key is set.', 'models' => array() );
		}
		$response = wp_remote_get( 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
			array( 'timeout' => 30, 'headers' => array( 'x-goog-api-key' => $key ) ) );
		if ( is_wp_error( $response ) ) {
			return array( 'ok' => false, 'error' => 'Could not reach Gemini: ' . $response->get_error_message(), 'models' => array() );
		}
		if ( 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return array( 'ok' => false, 'error' => 'Gemini ' . wp_remote_retrieve_response_code( $response ), 'models' => array() );
		}
		$models = array();
		foreach ( (array) ( json_decode( wp_remote_retrieve_body( $response ), true )['models'] ?? array() ) as $model ) {
			if ( ! in_array( 'generateContent', (array) ( $model['supportedGenerationMethods'] ?? array() ), true ) ) {
				continue;
			}
			$name = preg_replace( '#^models/#', '', (string) ( $model['name'] ?? '' ) );
			if ( preg_match( '/^gemini-[a-z0-9][a-z0-9.-]{0,60}$/', $name ) ) {
				$models[] = array( 'name' => $name, 'label' => (string) ( $model['displayName'] ?? '' ) );
			}
		}
		return array( 'ok' => true, 'models' => $models );
	}

	// ------------------------------------------------------------ the load test

	public static function load_test() {
		$saved = get_option( 'qd_loadtest', '' );
		return $saved ? QD_Util::json_array( $saved ) : null;
	}

	/** What the Admin page shows about a running load test (loadTestView_). */
	public static function load_test_view() {
		$lt = self::load_test();
		if ( ! $lt ) {
			return null;
		}
		$url = QD_Router::base_url();
		return array(
			'sid'     => $lt['sid'],
			'key'     => $lt['key'],
			'url'     => $url,
			'expires' => $lt['expires'],
			'expired' => QD_Util::now_ms() >= $lt['expires'],
			'command' => 'node scripts/loadtest.js --url "' . $url . '" --key ' . $lt['key'] . ' --count 40',
		);
	}

	public static function start_load_test() {
		$me = QD_People::require_admin();
		if ( ! self::load_test() ) {
			$session = array(
				'id'        => QD_Util::new_id( 8 ),
				'name'      => 'Load test ' . wp_date( 'M j g:i a' ),
				'heading'   => 'Load test',
				'access'    => 'link',
				'theme'     => 'dark',
				'maxLength' => QD_App::config( 'defaultMaxLength' ),
				'moderators' => array(),
				'emailOnEnd' => false,
				'linkKey'   => QD_Util::new_id( 16 ),
				'screenKey' => QD_Util::new_id( 16 ),
				'status'    => 'active',
				'open'      => true,
				'created'   => QD_Util::now_ms(),
				'started'   => QD_Util::now_ms(),
				'createdBy' => $me,
				'loadTest'  => true,
				'brand'     => array( 'orgName' => '', 'accent' => '' ),
			);
			QD_Store::save_session( $session );
			update_option( 'qd_loadtest', wp_json_encode( array(
				'key'     => QD_Util::new_id( 32 ),
				'sid'     => $session['id'],
				'expires' => QD_Util::now_ms() + (int) QD_App::config( 'loadTestMinutes' ) * 60000,
			) ), false );
			QD_Activity::log( 'Load test started', null, QD_App::config( 'loadTestMinutes' ) . ' minutes' );
		}
		return QD_Admin::state();
	}

	/** Switches the endpoint off and deletes the load-test session with its questions. */
	public static function stop_load_test() {
		QD_People::require_admin();
		$lt = self::load_test();
		if ( $lt ) {
			if ( QD_Store::get_session( $lt['sid'] ) ) {
				QD_Questions::delete_for_session( $lt['sid'] );
				QD_Store::delete_session_row( $lt['sid'] );
			}
			delete_option( 'qd_loadtest' );
			QD_Activity::log( 'Load test finished', null, '' );
		}
		return QD_Admin::state();
	}

	/**
	 * The load-test endpoint: it does nothing unless an administrator started a load test, and
	 * only that path skips the per-session cap. Registered as a public function so the load-test
	 * script can reach it the way a page would.
	 */
	public static function load_test_submit( $key = '', $text = '' ) {
		$lt      = self::load_test();
		$session = $lt ? QD_Store::get_session( $lt['sid'] ) : null;
		if ( ! $lt || ! $session || ! hash_equals( (string) $lt['key'], (string) $key ) || QD_Util::now_ms() >= $lt['expires'] ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		$started = QD_Util::now_ms();
		// A fresh device each time, joining with the session's own key, as a phone would.
		$answer  = QD_Participants::submit( $lt['sid'], wp_generate_uuid4(), (string) $text, $session['linkKey'], true );
		$answer['serverMs'] = QD_Util::now_ms() - $started;
		return $answer;
	}

	/** After a round the script asks how many questions really arrived. */
	public static function load_test_count( $key = '' ) {
		$lt = self::load_test();
		if ( ! $lt || ! hash_equals( (string) $lt['key'], (string) $key ) ) {
			return array( 'ok' => false, 'reason' => 'notFound' );
		}
		return array( 'ok' => true, 'saved' => count( QD_Questions::rows( $lt['sid'] ) ) );
	}
}
