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
		$sid  = (string) ( $p['s'] ?? '' );

		// The room screen and the slide: no sign-in, but the link's own key (r=) is checked.
		if ( 'present' === $view || 'panel' === $view ) {
			$session = QD_Store::get_session( $sid );
			if ( $session && ( QD_Sessions::screen_key_valid( $session, $p['r'] ?? '' ) || QD_People::can_moderate( $session, QD_People::current_email() ) ) ) {
				self::screen( $view, $session, ( $p['layout'] ?? '' ) === 'qr' ? 'qr' : 'full' );
			}
			if ( $session ) {
				self::notice( 'oldScreenLink', $view );
			}
			self::notice( QD_People::current_email() ? 'pick' : 'noSession', $view );
		}

		// The Event Coordinator portal: one link per event, and a sign-in — it shows what people
		// actually typed, so it is not a link to hand around.
		if ( 'coordinator' === $view ) {
			$email = QD_People::current_email();
			$event = QD_Store::get_event( (string) ( $p['e'] ?? '' ) );
			if ( ! $email || ! QD_People::events_for( $email ) ) {
				self::notice( 'denied', $view );
			}
			if ( ! $event ) {
				self::notice( 'pickEvent', $view );
			}
			if ( ! QD_People::can_coordinate( $event, $email ) ) {
				self::notice( 'denied', $view );
			}
			QD_Pages::send( 'Coordinator.html', $event['name'] . ' — event logistics', array(
				'eid'   => $event['id'],
				'board' => QD_Coordinator::board( $event['id'] ),
			), array( 'eventId' => $event['id'] ) );
		}

		if ( 'qrsheet' === $view ) {
			self::qr_sheet( (string) ( $p['e'] ?? '' ) );
		}

		if ( 'moderate' === $view ) {
			if ( ! current_user_can( 'qd_facilitate' ) && ! current_user_can( 'qd_manage' ) ) {
				self::notice( 'denied', $view );
			}
			$session = QD_Store::get_session( $sid );
			if ( ! $session ) {
				self::notice( 'pick', $view );
			}
			if ( ! QD_People::can_moderate( $session, QD_People::current_email() ) ) {
				self::notice( 'denied', $view );
			}
			QD_Pages::send( 'Moderate.html', 'QA - ' . $session['name'], array( 'sid' => $session['id'] ), $session );
		}

		if ( 'ask' === $view && empty( $sid ) ) {
			self::home();
		}
		if ( 'ask' === $view ) {
			self::ask( $sid, (string) ( $p['t'] ?? $p['k'] ?? '' ) );
		}
		self::notice( 'denied', $view );
	}

	/** The room screen (or the slide layout), and the panelist view. */
	private static function screen( $view, array $session, $layout ) {
		$key = QD_Sessions::screen_key( $session );
		if ( 'panel' === $view ) {
			QD_Pages::send( 'Panel.html', $session['name'] . ' — panel', array(
				'sid'     => $session['id'],
				'key'     => $key,
				'theme'   => $session['theme'] ?? 'dark',
				'version' => QD_VERSION,
			), $session );
		}
		QD_Pages::send( 'Present.html', $session['name'], array(
			'sid'       => $session['id'],
			'key'       => $key,
			'theme'     => $session['theme'] ?? 'dark',
			'layout'    => $layout,   // 'qr' is the compact slide view the PowerPoint add-in frames
			'languages' => QD_Settings::languages_for( $session ),
			'version'   => QD_VERSION,
		), $session );
	}

	/** Printable QR sheets for an event's shareable-link sessions (administrators). */
	private static function qr_sheet( $eid ) {
		if ( ! current_user_can( 'qd_manage' ) ) {
			self::notice( 'denied', 'qrsheet' );
		}
		$event = QD_Store::get_event( $eid );
		if ( ! $event ) {
			self::notice( 'pick', 'qrsheet' );
		}
		$sessions = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) !== $event['id'] || 'ended' === $s['status'] || ! empty( $s['loadTest'] ) ) {
				continue;
			}
			$sessions[] = array(
				'name'    => (string) $s['name'],
				'heading' => (string) ( $s['heading'] ?? '' ),
				'url'     => 'link' === $s['access'] ? QD_Sessions::links( $s )['participant'] : '',
			);
		}
		QD_Pages::send( 'Sheet.html', $event['name'] . ' — QR sheets', array(
			'eventName' => (string) $event['name'],
			'languages' => ! empty( $event['languages'] ) ? array_values( (array) $event['languages'] ) : QD_Settings::site_languages(),
			'sessions'  => $sessions,
		), array( 'eventId' => $event['id'] ) );
	}

	/** The Denied page, which is also the session picker (notice_). */
	private static function notice( $mode, $view ) {
		if ( 'pick' === $mode ) {
			$links = array();
			foreach ( QD_People::sessions_for( QD_People::current_email() ) as $s ) {
				if ( 'ended' === $s['status'] ) {
					continue;
				}
				$event   = QD_Store::event_name( $s );
				$links[] = array(
					'label' => $event ? $event . ' — ' . $s['name'] : $s['name'],
					'note'  => 'active' === $s['status'] ? 'Active' : 'Not active',
					'href'  => 'present' === $view ? QD_Sessions::links( $s )['present'] : self::base_url() . '?view=' . $view . '&s=' . $s['id'],
				);
			}
			QD_Pages::send( 'Denied.html', 'Choose a session', array(
				'heading' => 'Choose a session',
				'body'    => $links ? 'Pick the session to open.' : 'You are not assigned to any open sessions.',
				'links'   => $links,
			) );
		}
		if ( 'pickEvent' === $mode ) {
			$links = array();
			foreach ( QD_People::events_for( QD_People::current_email() ) as $ev ) {
				$links[] = array( 'label' => $ev['name'], 'note' => '', 'href' => QD_Coordinator::link( $ev ) );
			}
			QD_Pages::send( 'Denied.html', 'Choose an event', array(
				'heading' => 'Choose an event',
				'body'    => $links ? 'Pick the event to open.' : 'You are not an Event Coordinator for any event.',
				'links'   => $links,
			) );
		}
		if ( 'oldScreenLink' === $mode ) {
			QD_Pages::send( 'Denied.html', 'Room screen link out of date', array(
				'heading' => 'This room screen link is out of date',
				'body'    => 'Room screen and PowerPoint slide links changed. Ask whoever runs the session to copy the new one from the Admin page (Sessions → Links). To ask a question, scan the code on the screen in the room.',
				'links'   => array(),
			) );
		}
		if ( 'noSession' === $mode ) {
			QD_Pages::send( 'Denied.html', 'Session not found', array(
				'heading' => 'This room screen link is not valid',
				'body'    => 'Check the link with whoever is running the session, or scan the code on the screen in the room to ask a question.',
				'links'   => array(),
			) );
		}
		QD_Pages::send( 'Denied.html', 'Not available', array(
			'heading' => 'This view is for QA Facilitators',
			'body'    => 'Sign in with an account listed as a QA Facilitator, or scan the code on the screen in the room to ask a question.',
			'links'   => array(),
		) );
	}

	/** The participant page. An unknown session still gets the page, which says so. */
	public static function ask( $sid, $credential ) {
		$session = QD_Store::get_session( $sid );
		QD_Pages::send( 'Ask.html', 'Ask a question', array(
			'sid'        => $session ? $session['id'] : '',
			'credential' => substr( (string) $credential, 0, 64 ),
			'languages'  => QD_Settings::language_list( $session ),
		), $session );
	}

	/** The landing page: how to join, and staff links when signed in. */
	public static function home() {
		$user   = wp_get_current_user();
		$admin  = current_user_can( 'qd_manage' );
		$staff  = $admin || current_user_can( 'qd_facilitate' );
		$brand  = QD_Brand::site();
		$title  = $brand['orgName'] ? $brand['orgName'] . ' — Question Desk' : 'Question Desk';
		QD_Pages::send( 'Home.html', $title, array(
			'languages' => QD_Settings::site_languages(),
			'version'   => QD_VERSION,
			'signedIn'  => $user->exists(),
			'staff'     => $staff,
			'adminUrl'  => $admin ? admin_url( 'admin.php?page=question-desk' ) : '',
			'domain'    => '',
			'signInUrl' => wp_login_url( self::base_url() ),
			'sessions'  => $staff ? self::staff_sessions( QD_People::current_email() ) : array(),
		) );
	}

	/** The open sessions a staff member can work on, with their links (home_()). */
	public static function staff_sessions( $email ) {
		$out = array();
		foreach ( QD_People::sessions_for( $email ) as $s ) {
			if ( 'ended' === ( $s['status'] ?? '' ) || ! empty( $s['loadTest'] ) ) {
				continue;
			}
			$links = QD_Sessions::links( $s );
			$out[] = array(
				'name'      => (string) $s['name'],
				'eventName' => QD_Store::event_name( $s ),
				'status'    => (string) $s['status'],
				'present'   => $links['present'],
				'moderate'  => $links['moderate'],
			);
		}
		return $out;
	}
}
