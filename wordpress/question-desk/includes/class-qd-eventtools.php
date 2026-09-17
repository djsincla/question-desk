<?php
/**
 * Event tools: emailing QA Facilitators their own session links, the event's summary, the
 * day-of checklist, and emailing one session's links (events.js and parts of admin.js).
 */

defined( 'ABSPATH' ) || exit;

class QD_EventTools {

	public static function init() {
		QD_Api::register( 'emailEventFacilitators', array( __CLASS__, 'email_facilitators' ), 'manage' );
		QD_Api::register( 'emailEventSummary', array( __CLASS__, 'email_event_summary' ), 'manage' );
		QD_Api::register( 'eventChecklist', array( __CLASS__, 'checklist' ), 'manage' );
		QD_Api::register( 'emailLinks', array( __CLASS__, 'email_links' ), 'manage' );
	}

	private static function event_sessions( $eid, $include_ended = true ) {
		$out = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) !== $eid || ! empty( $s['loadTest'] ) ) {
				continue;
			}
			if ( ! $include_ended && 'ended' === $s['status'] ) {
				continue;
			}
			$out[] = $s;
		}
		usort( $out, function ( $a, $b ) {
			return ( (int) ( $a['order'] ?? 0 ) ) <=> ( (int) ( $b['order'] ?? 0 ) );
		} );
		return $out;
	}

	/** One email per QA Facilitator, listing only the sessions they are running. */
	public static function email_facilitators( $eid = '' ) {
		QD_People::require_admin();
		$event = QD_Store::get_event( $eid );
		if ( ! $event ) {
			throw new QD_Error( 'Event not found.' );
		}
		$sessions = self::event_sessions( $eid, false );
		if ( ! $sessions ) {
			throw new QD_Error( 'This event has no sessions that haven\'t ended.' );
		}
		$by_person = array();
		foreach ( $sessions as $s ) {
			foreach ( QD_People::facilitators_for( $s ) as $email ) {
				$by_person[ $email ][] = $s;
			}
		}
		if ( ! $by_person ) {
			throw new QD_Error( 'No QA Facilitators are assigned to this event or its sessions.' );
		}
		$when = function ( $s ) {
			if ( empty( $s['scheduledStart'] ) ) {
				return '';
			}
			$start = wp_date( 'D M j, g:i a', (int) round( $s['scheduledStart'] / 1000 ) );
			return $start . ( ! empty( $s['scheduledEnd'] ) ? ' – ' . wp_date( 'g:i a', (int) round( $s['scheduledEnd'] / 1000 ) ) : '' );
		};
		$event_brand = QD_Brand::for_session( $sessions[0] );

		foreach ( $by_person as $address => $list ) {
			$body = '<p style="margin:0 0 18px">The ' . ( 1 === count( $list ) ? 'session' : count( $list ) . ' sessions' )
				. ' you are running in ' . esc_html( $event['name'] )
				. '. Each link opens that session\'s question queue, and needs your WordPress account.</p>';
			foreach ( $list as $s ) {
				$links  = QD_Sessions::links( $s );
				$accent = QD_Brand::for_session( $s )['accent'];
				$line   = function ( $label, $url ) use ( $accent ) {
					return '<br><span style="color:#5c6874">' . $label . ':</span> <a href="' . esc_url( $url )
						. '" style="color:' . $accent . '">' . esc_html( $url ) . '</a>';
				};
				$body  .= '<p style="margin:0 0 20px;padding-left:10px;border-left:3px solid ' . $accent . '"><strong>'
					. esc_html( $s['name'] ) . '</strong>'
					. ( ! empty( $s['room'] ) ? ' <span style="color:#5c6874">· ' . esc_html( $s['room'] ) . '</span>' : '' )
					. ( $when( $s ) ? '<br><span style="color:#5c6874">' . esc_html( $when( $s ) ) . '</span>' : '' )
					. $line( 'QA Facilitator queue', $links['moderate'] ) . '</p>';
			}
			QD_Summaries::mail( $address, $event['name'] . ' — your Question Desk sessions',
				QD_Summaries::shell( $event_brand, esc_html( $event['name'] ), $body ), $event_brand );
		}
		$people = count( $by_person );
		QD_Activity::log( 'Session links emailed to QA Facilitators', array( 'id' => $eid, 'eventName' => $event['name'] ),
			$people . ( 1 === $people ? ' QA Facilitator' : ' QA Facilitators' ) . ', ' . count( $sessions )
			. ( 1 === count( $sessions ) ? ' session' : ' sessions' ) );
		return array( 'facilitators' => $people, 'sessions' => count( $sessions ) );
	}

	/** Every session in the event, in one email, with all the questions as one CSV. */
	public static function email_event_summary( $eid = '', $recipients = array() ) {
		QD_People::require_admin();
		$event = QD_Store::get_event( $eid );
		if ( ! $event ) {
			throw new QD_Error( 'Event not found.' );
		}
		$sessions = self::event_sessions( $eid );
		if ( ! $sessions ) {
			throw new QD_Error( 'This event has no sessions yet.' );
		}
		$to = $recipients ? QD_Util::parse_emails( $recipients ) : array();
		if ( ! $to ) {
			foreach ( $sessions as $s ) {
				foreach ( QD_Settings::summary_recipients( $s ) as $email ) {
					if ( ! in_array( $email, $to, true ) ) {
						$to[] = $email;
					}
				}
			}
			$to = array_slice( $to, 0, (int) QD_App::config( 'maxRecipients' ) );
		}
		if ( ! $to ) {
			throw new QD_Error( 'Add at least one recipient.' );
		}
		$brand = QD_Brand::for_session( $sessions[0] );
		// What the questions say about the event, before the questions themselves.
		try {
			$review = self::review_section( QD_Gemini::event_review( $eid ), $brand );
		} catch ( Throwable $e ) {
			error_log( 'Question Desk event review: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			$review = self::review_problem( 'The review could not be made: ' . $e->getMessage() );
		}
		$body      = '<p style="color:#5c6874;margin:0 0 8px">' . count( $sessions ) . ( 1 === count( $sessions ) ? ' session' : ' sessions' );
		$header    = null;
		$csv_rows  = array();
		$questions = 0;
		$sections  = '';
		foreach ( $sessions as $s ) {
			$content    = QD_Summaries::content( $s, QD_Brand::for_session( $s ) );
			$header     = array_merge( array( 'Session' ), $content['header'] );
			$questions += $content['questions'];
			$sections  .= '<h1 style="font-size:19px;margin:32px 0 4px;padding-top:12px;border-top:1px solid #d9dee3">'
				. esc_html( $s['name'] ) . '</h1>' . $content['body'];
			foreach ( $content['rows'] as $row ) {
				$csv_rows[] = array_merge( array( $s['name'] ), $row );
			}
		}
		$body .= ' · ' . $questions . ' questions</p>' . $review . $sections;

		$name     = trim( preg_replace( '/\s+/', '-', preg_replace( '/[^\w -]+/u', '', $event['name'] ) ) );
		$path     = trailingslashit( get_temp_dir() ) . ( $name ? $name : 'event' ) . '-questions.csv';
		file_put_contents( $path, "\xEF\xBB\xBF" . QD_Csv::lines( array_merge( array( $header ), $csv_rows ) ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		foreach ( $to as $address ) {
			QD_Summaries::mail( $address, $event['name'] . ' — questions summary for the whole event',
				QD_Summaries::shell( $brand, esc_html( $event['name'] ) . ' — questions', $body ), $brand, array( $path ) );
		}
		wp_delete_file( $path );
		QD_Activity::log( 'Event summary emailed', array( 'id' => $eid, 'eventName' => $event['name'] ), 'to ' . implode( ', ', $to ) );
		return count( $to );
	}

	/** The review as email HTML, or a line saying why there isn't one (reviewSection_). */
	private static function review_section( $result, array $brand ) {
		if ( empty( $result['ok'] ) ) {
			return self::review_problem( $result['error'] ?? '' );
		}
		$r    = $result['review'];
		$head = function ( $text ) {
			return '<h2 style="font-size:15px;margin:18px 0 6px;color:#16202b">' . esc_html( $text ) . '</h2>';
		};
		$note = function ( $text ) {
			return '<p style="margin:0 0 10px;color:#3c4854">' . esc_html( $text ) . '</p>';
		};
		$html = '<div style="background:#f5f7f9;border-left:4px solid ' . $brand['accent'] . ';padding:14px 18px;margin:0 0 26px">'
			. '<h1 style="font-size:17px;margin:0 0 4px">What the questions say</h1>'
			. '<p style="margin:0 0 12px;color:#5c6874;font-size:13px">Written by Gemini from ' . (int) $result['reviewed']
			. ' of the ' . (int) $result['questions'] . ( 1 === (int) $result['questions'] ? ' question' : ' questions' )
			. ' asked across ' . (int) $result['sessions'] . ( 1 === (int) $result['sessions'] ? ' session' : ' sessions' )
			. '. Read it as a starting point, not a verdict.</p>'
			. $note( $r['sentiment'] );

		if ( ! empty( $r['themes'] ) ) {
			$html .= $head( 'Themes worth acting on' ) . '<ol style="margin:0 0 4px;padding-left:20px;color:#3c4854">';
			foreach ( $r['themes'] as $theme ) {
				$html .= '<li style="margin-bottom:10px"><strong>' . esc_html( $theme['title'] ) . '</strong><br>'
					. esc_html( $theme['what'] ) . '<br><span style="color:#5c6874">Next time: '
					. esc_html( $theme['nextTime'] ) . '</span></li>';
			}
			$html .= '</ol>';
		}
		if ( ! empty( $r['logistics'] ) ) {
			$html .= $head( 'Running the event' ) . '<ul style="margin:0 0 4px;padding-left:20px;color:#3c4854">';
			foreach ( $r['logistics'] as $item ) {
				$html .= '<li style="margin-bottom:8px">' . esc_html( $item['issue'] )
					. '<br><span style="color:#5c6874">Next time: ' . esc_html( $item['nextTime'] ) . '</span></li>';
			}
			$html .= '</ul>';
		}
		if ( ! empty( $r['individual']['count'] ) ) {
			$count = (int) $r['individual']['count'];
			$html .= $head( 'Questions about one person\'s situation' )
				. $note( $count . ( 1 === $count ? ' question was' : ' questions were' ) . ' about somebody\'s own circumstances. '
					. $r['individual']['pattern'] )
				. $note( 'For everyone in that position: ' . $r['individual']['atScale'] );
		}
		if ( ! empty( $r['sessionIdeas'] ) ) {
			$html .= $head( 'Sessions to consider next time' ) . '<ul style="margin:0;padding-left:20px;color:#3c4854">';
			foreach ( $r['sessionIdeas'] as $idea ) {
				$html .= '<li style="margin-bottom:4px">' . esc_html( $idea ) . '</li>';
			}
			$html .= '</ul>';
		}
		return $html . '</div>';
	}

	private static function review_problem( $why ) {
		return '<p style="background:#f5f7f9;padding:12px 16px;margin:0 0 26px;color:#5c6874">'
			. 'The questions are below, but no review was written this time. ' . esc_html( $why ) . '</p>';
	}

	/** One session's links by email, to its QA Facilitators or to addresses given. */
	public static function email_links( $sid = '', $options = array() ) {
		QD_People::require_admin();
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			throw new QD_Error( 'Session not found.' );
		}
		$options = (array) $options;
		$to      = ! empty( $options['toModerators'] ) ? QD_People::facilitators_for( $session ) : QD_Util::parse_emails( $options['to'] ?? array() );
		if ( ! $to ) {
			throw new QD_Error( ! empty( $options['toModerators'] )
				? 'This session has no QA Facilitators assigned.' : 'Add at least one recipient.' );
		}
		$links = QD_Sessions::links( $session );
		$items = array();
		if ( ! empty( $options['participant'] ) ) {
			if ( ! $links['participant'] ) {
				throw new QD_Error( 'In-room sessions have no shareable link — people join by scanning the room screen.' );
			}
			$items[] = array( 'Ask a question', $links['participant'], 'Anyone with this link can submit a question anonymously.' );
		}
		if ( ! empty( $options['present'] ) ) {
			$items[] = array( 'Room screen', $links['present'],
				'Open on the projector — no sign-in needed. Anyone with this link can see the join code, so share it only with the people running the room.' );
		}
		if ( ! empty( $options['moderate'] ) ) {
			$items[] = array( 'QA Facilitator queue', $links['moderate'],
				'Questions grouped by topic. Requires signing in with an assigned WordPress account.' );
		}
		if ( ! $items ) {
			throw new QD_Error( 'Choose at least one link to send.' );
		}
		$brand = QD_Brand::for_session( $session );
		$inner = '';
		foreach ( $items as $item ) {
			$inner .= '<p style="margin:0 0 18px"><strong>' . esc_html( $item[0] ) . '</strong><br>'
				. '<a href="' . esc_url( $item[1] ) . '" style="color:' . $brand['accent'] . '">' . esc_html( $item[1] ) . '</a><br>'
				. '<span style="color:#5c6874">' . esc_html( $item[2] ) . '</span></p>';
		}
		$html = QD_Summaries::shell( $brand, esc_html( $session['name'] ), $inner );
		foreach ( $to as $address ) {
			// One message each, so addresses are never exposed to one another.
			QD_Summaries::mail( $address, $session['name'] . ' — Question Desk links', $html, $brand );
		}
		QD_Activity::log( 'Links emailed', $session, 'to ' . implode( ', ', $to ) );
		return count( $to );
	}

	/** The day-of checklist for an event: the site, then each session. */
	public static function checklist( $eid = '' ) {
		QD_People::require_admin();
		$event = QD_Store::get_event( $eid );
		if ( ! $event ) {
			throw new QD_Error( 'Event not found.' );
		}
		$now    = QD_Util::now_ms();
		$fmt    = function ( $ms ) {
			return wp_date( 'D M j, g:i a', (int) round( $ms / 1000 ) );
		};
		$health = (array) get_option( 'qd_health', array() );
		$cron   = (bool) wp_next_scheduled( QD_Schedule::MINUTE_HOOK );
		$key    = QD_Gemini::key();
		$site   = array(
			array(
				'label'  => 'Question grouping runs every minute',
				'ok'     => $cron,
				'detail' => $cron ? ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ? 'WP-Cron is disabled: the host must run wp-cron.php every minute.' : '' )
					: 'Deactivate and activate Question Desk to schedule it again.',
			),
			array(
				'label'  => 'Gemini is set up',
				'ok'     => (bool) $key && empty( $health['failures'] ),
				'detail' => ! $key ? 'No Gemini API key: add one under Admin → Health.'
					: ( ! empty( $health['failures'] ) ? 'Grouping failed ' . $health['failures'] . ' times in a row: ' . ( $health['lastError'] ?? '' ) : '' ),
			),
			array(
				'label'  => 'Email',
				'ok'     => null,
				'detail' => 'WordPress sends with ' . ( self::smtp_in_use() ? 'an SMTP plugin' : 'PHP mail(), which many hosts drop — an SMTP plugin is safer' ) . '.',
			),
		);

		$sessions = array();
		foreach ( self::event_sessions( $eid ) as $s ) {
			$links        = QD_Sessions::links( $s );
			$facilitators = QD_People::facilitators_for( $s );
			$recipients   = QD_Settings::summary_recipients( $s );
			$checks       = array();
			if ( 'ended' === $s['status'] ) {
				$checks[] = array(
					'label'  => 'Ended',
					'ok'     => true,
					'detail' => ! empty( $s['summarySent'] ) ? 'Summary emailed ' . $fmt( $s['summarySent'] )
						: ( ! empty( $s['summaryPending'] ) ? 'Summary not sent yet: ' . ( $s['summaryPending']['error'] ?? '' ) : '' ),
				);
			} else {
				if ( 'active' === $s['status'] ) {
					$checks[] = array( 'label' => 'Active and taking questions', 'ok' => false !== ( $s['open'] ?? true ),
						'detail' => false === ( $s['open'] ?? true ) ? 'Questions are paused.' : '' );
				} elseif ( ! empty( $s['scheduledStart'] ) && empty( $s['scheduleStarted'] ) ) {
					$checks[] = array( 'label' => 'Starts on its own', 'ok' => $s['scheduledStart'] > $now, 'detail' => $fmt( $s['scheduledStart'] ) );
				} else {
					$checks[] = array( 'label' => 'Not active', 'ok' => null, 'detail' => 'Activate it on the Sessions tab when doors open.' );
				}
				$checks[] = ! empty( $s['scheduledEnd'] )
					? array( 'label' => 'Ends on its own', 'ok' => $s['scheduledEnd'] > $now, 'detail' => $fmt( $s['scheduledEnd'] ) )
					: array( 'label' => 'No scheduled end', 'ok' => null, 'detail' => 'End it by hand afterwards.' );
				$checks[] = array( 'label' => 'QA Facilitators', 'ok' => (bool) $facilitators,
					'detail' => $facilitators ? implode( ', ', $facilitators ) : 'Nobody can run the queue except administrators.' );
				$checks[] = array(
					'label'  => 'Summary email',
					'ok'     => empty( $s['emailOnEnd'] ) ? null : (bool) $recipients,
					'detail' => empty( $s['emailOnEnd'] ) ? 'Not emailed when it ends.'
						: ( $recipients ? 'To ' . implode( ', ', $recipients ) : 'Turned on, but nobody would get it.' ),
				);
				$checks[] = array( 'label' => 'Prepared questions', 'ok' => true,
					'detail' => (string) count( QD_Questions::prepared_for( $s['id'] ) ) );
			}
			$languages  = array_map( array( 'QD_Settings', 'language_name' ), QD_Settings::languages_for( $s ) );
			$sessions[] = array(
				'id'        => $s['id'],
				'name'      => $s['name'],
				'status'    => $s['status'],
				'access'    => $s['access'],
				'languages' => implode( ', ', $languages ),
				'links'     => array( 'present' => $links['present'], 'slide' => $links['slide'], 'panel' => $links['panel'],
					'moderate' => $links['moderate'], 'participant' => $links['participant'] ),
				'checks'    => $checks,
			);
		}
		return array( 'event' => array( 'id' => $event['id'], 'name' => $event['name'] ), 'site' => $site,
			'sessions' => $sessions, 'generated' => $now );
	}

	/** Whether something has taken over wp_mail (an SMTP plugin), for the checklist. */
	private static function smtp_in_use() {
		return has_action( 'phpmailer_init' ) || function_exists( 'wp_mail_smtp' ) || defined( 'WPMS_ON' );
	}
}
