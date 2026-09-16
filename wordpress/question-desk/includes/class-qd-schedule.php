<?php
/**
 * The every-minute run: start and end sessions by their schedule, then group and translate new
 * questions in each active session (clusterAll_ and runSchedule_ in the Apps Script version).
 *
 * WP-Cron only fires when the site gets traffic, so a queue refresh also kicks a session's
 * grouping when it is due. A real system cron on the host is still the reliable way; the plugin
 * works either way, and the kick means an event with facilitators watching never stalls.
 */

defined( 'ABSPATH' ) || exit;

class QD_Schedule {

	const MINUTE_HOOK  = 'qd_minute';
	const SESSION_HOOK = 'qd_group_session';
	const DUE_SECONDS  = 60;

	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'add_interval' ) );   // phpcs:ignore WordPress.WP.CronInterval
		add_action( self::MINUTE_HOOK, array( __CLASS__, 'run_minute' ) );
		add_action( self::SESSION_HOOK, array( __CLASS__, 'group_one' ) );
	}

	public static function add_interval( $schedules ) {
		$schedules['qd_minute'] = array( 'interval' => 60, 'display' => 'Every minute (Question Desk)' );
		return $schedules;
	}

	public static function schedule() {
		if ( ! wp_next_scheduled( self::MINUTE_HOOK ) ) {
			wp_schedule_event( time() + 60, 'qd_minute', self::MINUTE_HOOK );
		}
	}

	public static function unschedule() {
		wp_clear_scheduled_hook( self::MINUTE_HOOK );
	}

	/** The whole minute's work. */
	public static function run_minute() {
		self::run_sessions_schedule();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( 'active' === $s['status'] && empty( $s['loadTest'] ) ) {
				self::group_one( $s['id'] );
			}
		}
	}

	/** Starts and ends sessions whose time has come (runSchedule_). */
	public static function run_sessions_schedule() {
		QD_Activity::$who = 'Schedule (automatic)';
		$now              = QD_Util::now_ms();
		$changed          = 0;
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( 'ended' === $s['status'] ) {
				continue;
			}
			try {
				if ( ! empty( $s['scheduledEnd'] ) && $now >= $s['scheduledEnd'] ) {
					QD_Sessions::end_session( $s['id'] );
					$changed++;
				} elseif ( ! empty( $s['scheduledStart'] ) && $now >= $s['scheduledStart'] && empty( $s['scheduleStarted'] ) ) {
					// Starts once: an administrator who deactivates it afterwards is left alone.
					$started = QD_Store::update_session( $s['id'], function ( &$x ) use ( $now ) {
						$x['scheduleStarted'] = true;
						$x['status']          = 'active';
						if ( empty( $x['started'] ) ) {
							$x['started'] = $now;
						}
					} );
					QD_Activity::log( 'Session started', $started, 'by its schedule' );
					$changed++;
				}
			} catch ( Throwable $e ) {
				error_log( 'Question Desk schedule for ' . $s['id'] . ': ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			}
		}
		QD_Activity::$who = '';
		return $changed;
	}

	/** Groups one session's new questions, recording whether it worked. */
	public static function group_one( $sid ) {
		QD_Cache::set( 'grouped_' . $sid, QD_Util::now_ms(), 3600 );
		try {
			$done = QD_Gemini::cluster_session( $sid );
			if ( $done ) {
				self::note_result( '' );   // idle minutes are not recorded either way
			}
			return $done;
		} catch ( Throwable $e ) {
			self::note_result( $e->getMessage() );
			return 0;
		}
	}

	/**
	 * From a queue refresh: if this session hasn't been grouped for a minute, ask WordPress to
	 * do it now, in its own request, so the refresh itself stays quick.
	 */
	public static function kick( array $session ) {
		if ( 'active' !== $session['status'] || ! QD_Gemini::key() ) {
			return;
		}
		$last = (int) QD_Cache::get( 'grouped_' . $session['id'] );
		if ( $last && QD_Util::now_ms() - $last < self::DUE_SECONDS * 1000 ) {
			return;
		}
		QD_Cache::set( 'grouped_' . $session['id'], QD_Util::now_ms(), 3600 );   // claim it now
		if ( ! wp_next_scheduled( self::SESSION_HOOK, array( $session['id'] ) ) ) {
			wp_schedule_single_event( time(), self::SESSION_HOOK, array( $session['id'] ) );
			spawn_cron();
		}
	}

	/**
	 * Counts grouping runs. After CONFIG.alertAfterFailures failures in a row administrators
	 * are told (phase 5 sends the email); the queue says so as soon as there are two.
	 */
	public static function note_result( $error ) {
		$health = (array) get_option( 'qd_health', array() );
		$now    = QD_Util::now_ms();
		if ( $error ) {
			$health['failures']    = (int) ( $health['failures'] ?? 0 ) + 1;
			$health['lastError']   = mb_substr( (string) $error, 0, 500 );
			$health['lastErrorAt'] = $now;
		} else {
			$health['failures'] = 0;
			$health['lastOkAt'] = $now;
		}
		update_option( 'qd_health', $health, false );
		return $health;
	}
}
