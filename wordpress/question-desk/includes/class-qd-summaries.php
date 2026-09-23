<?php
/**
 * Session summaries by email, with the questions as a CSV (summaries.js).
 *
 * The summary always shows what was actually asked as well as the English translation: a
 * facilitator reads these to a room that includes native speakers of the original.
 */

defined( 'ABSPATH' ) || exit;

class QD_Summaries {

	public static function init() {
		QD_Api::register( 'emailSummary', array( __CLASS__, 'email_summary' ), 'facilitate' );
	}

	/** Sends one session's summary. Answers how many people got it. */
	public static function send( array $session, $recipients ) {
		$to = QD_Util::parse_emails( $recipients );
		if ( ! $to ) {
			return 0;
		}
		$brand    = QD_Brand::for_session( $session );
		$content  = self::content( $session, $brand );
		$csv      = QD_Csv::lines( array_merge( array( $content['header'] ), $content['rows'] ) );
		$name     = trim( preg_replace( '/\s+/', '-', preg_replace( '/[^\w -]+/u', '', $session['name'] ) ) );
		$filename = ( $name ? $name : 'session' ) . '-questions.csv';
		$path     = trailingslashit( get_temp_dir() ) . $filename;
		file_put_contents( $path, "\xEF\xBB\xBF" . $csv );   // phpcs:ignore WordPress.WP.AlternativeFunctions -- an attachment for wp_mail

		$subject = ( ! empty( $brand['eventName'] ) ? $brand['eventName'] . ': ' : '' ) . $session['name'] . ' — questions summary';
		$body    = self::shell( $brand, esc_html( $session['name'] ) . ' — questions', $content['body'] );
		$sent    = 0;
		foreach ( $to as $address ) {
			// One message each, so people outside the organization don't see the other addresses.
			if ( self::mail( $address, $subject, $body, $brand, array( $path ) ) ) {
				$sent++;
			}
		}
		wp_delete_file( $path );
		QD_Store::update_session( $session['id'], function ( &$s ) {
			$s['summarySent'] = QD_Util::now_ms();
			unset( $s['summaryPending'] );
		} );
		return $sent;
	}

	/** One session's summary: the email body (topics and every question) and the CSV rows. */
	public static function content( array $session, array $brand ) {
		$sid     = $session['id'];
		$rows    = QD_Questions::rows( $sid );
		$records = QD_Topics::records( $sid );
		$votes   = QD_Topics::votes( $sid );
		$fmt     = function ( $ms ) {
			return $ms ? wp_date( 'M j, Y g:i a', (int) round( $ms / 1000 ) ) : '—';
		};
		$merged  = function ( $topic ) use ( $records ) {
			return (string) ( $records[ $topic ]['merged'] ?? '' );
		};

		$kept   = array();
		$groups = array();
		foreach ( $rows as $q ) {
			if ( 'dismissed' === $q['status'] ) {
				continue;
			}
			$kept[]                                  = $q;
			$groups[ $q['topic'] ? $q['topic'] : QD_App::t( 'mail.summaryNotGrouped' ) ][] = $q;
		}
		$order = array_keys( $groups );
		usort( $order, function ( $a, $b ) use ( $groups, $votes ) {
			return ( count( $groups[ $b ] ) + ( $votes[ $b ] ?? 0 ) ) <=> ( count( $groups[ $a ] ) + ( $votes[ $a ] ?? 0 ) );
		} );

		$dismissed = count( $rows ) - count( $kept );
		$body      = '<p style="color:#5c6874;margin:0 0 20px">'
			. esc_html( $fmt( $session['started'] ?? null ) ) . ' – ' . esc_html( $fmt( $session['ended'] ?? null ) ) . '<br>'
			. count( $kept ) . ' questions in ' . count( $order ) . ' topics'
			. ( $dismissed ? ' · ' . $dismissed . ' dismissed' : '' ) . '</p>';

		foreach ( $order as $topic ) {
			$body .= '<h2 style="font-size:16px;margin:24px 0 8px;border-left:4px solid ' . $brand['accent'] . ';padding-left:8px">'
				. esc_html( $topic ) . ' <span style="color:#5c6874;font-weight:400">(' . count( $groups[ $topic ] )
				. ( ! empty( $votes[ $topic ] ) ? ' · ' . $votes[ $topic ] . ' me too' : '' ) . ')'
				. ( ! empty( $records[ $topic ]['shown'] ) ? QD_App::t( 'mail.summaryShown' ) : '' ) . '</span></h2>';
			if ( $merged( $topic ) ) {
				$body .= '<p style="background:#fffdf5;border-left:3px solid #d9c27a;padding:8px 12px;margin:0 0 8px">'
					. esc_html( $merged( $topic ) ) . '</p>';
			}
			$body .= '<ul style="margin:0;padding-left:20px">';
			foreach ( $groups[ $topic ] as $q ) {
				// Always keep what was actually asked. A question in another language shows the
				// English translation and the original; an untranslated one says so.
				$small = '<br><span style="color:#5c6874;font-size:13px">';
				$tick  = 'answered' === $q['status'] ? '<span style="color:' . $brand['accent'] . '">✓ </span>' : '';
				if ( ! $q['translation'] ) {
					$item = esc_html( $q['text'] ) . $small . QD_App::t( 'mail.summaryUntranslated' )
						. ( $q['lang'] ? ' (' . esc_html( $q['lang'] ) . ')' : '' ) . '</span>';
				} elseif ( self::same_language( $q ) ) {
					$item = esc_html( $q['text'] );
				} else {
					$item = esc_html( $q['translation'] ) . $small . 'Original (' . esc_html( $q['lang'] ? $q['lang'] : QD_App::t( 'mail.summaryUnknownLanguage' ) )
						. '): ' . esc_html( $q['text'] ) . '</span>';
				}
				$single = ( ! $q['topic'] && ! empty( $votes[ QD_Topics::single_key( $q['id'] ) ] ) )
					? $small . $votes[ QD_Topics::single_key( $q['id'] ) ] . ' me too · shown on phones</span>' : '';
				$body  .= '<li style="margin-bottom:8px">' . $tick . $item . $single . '</li>';
			}
			$body .= '</ul>';
		}

		$header = array( 'ID', 'Submitted', 'Status', 'Topic', 'Original language', 'Original question',
			QD_App::config( 'moderatorLanguage' ) . ' translation', 'Merged question for topic', 'Me too (topic)',
			'Topic shown on phones' );
		$shown  = (array) ( $session['shownQuestions'] ?? array() );
		$csv    = array();
		foreach ( $rows as $q ) {
			$translation = $q['translation'] ? $q['translation'] : ( self::same_language( $q ) ? $q['text'] : '(not translated)' );
			$on_phones   = $q['topic'] ? ! empty( $records[ $q['topic'] ]['shown'] ) : in_array( $q['id'], $shown, true );
			$csv[]       = array(
				$q['id'], $fmt( $q['submitted'] ), $q['status'], $q['topic'], $q['lang'], $q['text'], $translation,
				$merged( $q['topic'] ),
				$q['topic'] ? ( $votes[ $q['topic'] ] ?? 0 ) : ( $votes[ QD_Topics::single_key( $q['id'] ) ] ?? 0 ),
				$on_phones ? 'yes' : 'no',
			);
		}
		return array( 'body' => $body, 'header' => $header, 'rows' => $csv, 'questions' => count( $kept ), 'topics' => count( $order ) );
	}

	/** Was this asked in the facilitators' language (so one line is enough)? */
	public static function same_language( array $q ) {
		// The language wins when it is known: Gemini echoing a Korean question back is not a
		// translation.
		if ( $q['lang'] ) {
			return strtolower( $q['lang'] ) === strtolower( (string) QD_App::config( 'moderatorLanguage' ) );
		}
		return $q['translation'] && $q['translation'] === $q['text'];
	}

	/** The Admin page's "Email the summary now" (emailSummary). */
	public static function email_summary( $sid = '', $recipients = array() ) {
		$session = QD_People::require_session( $sid );
		$to      = $recipients ? $recipients : QD_Settings::summary_recipients( $session );
		if ( ! $to ) {
			throw new QD_Error( QD_App::t( 'wp.err.noRecipientsYet' ) );
		}
		$sent = self::send( $session, $to );
		QD_Activity::log( 'Summary emailed', $session, $sent . ( 1 === $sent ? ' recipient' : ' recipients' ) );
		return array( 'emailed' => $sent );
	}

	/** The frame every Question Desk email uses (emailShell_). */
	public static function shell( array $brand, $title, $inner ) {
		return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16202b;max-width:640px;line-height:1.5">'
			. '<div style="border-top:4px solid ' . $brand['accent'] . ';padding-top:12px">'
			. '<p style="color:#5c6874;font-size:13px;margin:0 0 4px">' . esc_html( $brand['orgName'] ? $brand['orgName'] : 'Question Desk' ) . '</p>'
			. '<h1 style="font-size:20px;margin:0 0 16px">' . $title . '</h1>' . $inner
			. ( ! empty( $brand['footer'] ) ? '<p style="color:#5c6874;font-size:13px;margin:28px 0 0;border-top:1px solid #d9dee3;padding-top:10px">'
				. esc_html( $brand['footer'] ) . '</p>' : '' )
			. '</div></div>';
	}

	/** One HTML email, from the organization's name (wp_mail; hosts should add SMTP). */
	public static function mail( $to, $subject, $html, array $brand, array $attachments = array() ) {
		$from    = $brand['orgName'] ? $brand['orgName'] : 'Question Desk';
		$headers = array( 'Content-Type: text/html; charset=UTF-8', 'From: ' . $from . ' <' . self::from_address() . '>' );
		return wp_mail( $to, $subject, $html, $headers, $attachments );
	}

	private static function from_address() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$host = preg_replace( '/^www\./i', '', (string) $host );
		return apply_filters( 'qd_from_address', 'wordpress@' . $host );
	}
}
