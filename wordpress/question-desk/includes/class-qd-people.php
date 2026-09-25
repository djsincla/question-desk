<?php
/**
 * Administrators and QA Facilitators as WordPress users (people.js in the Apps Script version).
 *
 * - WordPress Administrators always manage Question Desk (the Apps Script "owner").
 * - The QA Desk Admin role (qd_admin) manages Question Desk without being a site administrator.
 * - The QA Facilitator role (qd_facilitator) runs queues for the sessions they're assigned to.
 * Sessions and events list their QA Facilitators by email, as in the Apps Script version, so the
 * sessions CSV is the same file in both.
 */

defined( 'ABSPATH' ) || exit;

class QD_People {

	public static function current_email() {
		$user = wp_get_current_user();
		return $user->exists() ? strtolower( $user->user_email ) : '';
	}

	/** The site's administrator email: shown as the owner, who can't be removed. */
	public static function owner_email() {
		return strtolower( (string) get_option( 'admin_email' ) );
	}

	public static function user_can_email( $email, $cap ) {
		$user = $email ? get_user_by( 'email', $email ) : false;
		return $user && user_can( $user, $cap );
	}

	public static function is_admin( $email = null ) {
		if ( null === $email ) {
			return current_user_can( 'qd_manage' );
		}
		return self::user_can_email( $email, 'qd_manage' );
	}

	/** Emails of everyone who manages Question Desk (site administrators and QA Desk Admins). */
	public static function admins() {
		$emails = array();
		foreach ( get_users( array( 'role__in' => array( QD_App::t( 'admin.roleAdministrator' ), 'qd_admin' ), 'fields' => array( 'user_email' ) ) ) as $u ) {
			$emails[] = strtolower( $u->user_email );
		}
		return array_values( array_unique( $emails ) );
	}

	/** Emails of QA Facilitators (the role), as roster_('MODERATORS'). */
	public static function moderators() {
		$emails = array();
		foreach ( get_users( array( 'role' => 'qd_facilitator', 'fields' => array( 'user_email' ) ) ) as $u ) {
			$emails[] = strtolower( $u->user_email );
		}
		return array_values( array_unique( $emails ) );
	}

	/** What each role is called on screen and in the activity log. */
	public static function role_name( $role ) {
		$names = array( 'admin' => 'Administrator', 'moderator' => QD_App::t( 'admin.roleFacilitator' ), 'coordinator' => QD_App::t( 'admin.roleCoordinator' ) );
		return $names[ $role ] ?? $names['moderator'];
	}

	/** Emails of everyone holding the Event Coordinator role. */
	public static function coordinators() {
		$emails = array();
		foreach ( get_users( array( 'role' => 'qd_coordinator', 'fields' => array( 'user_email' ) ) ) as $u ) {
			$emails[] = strtolower( $u->user_email );
		}
		return array_values( array_unique( $emails ) );
	}

	/** An event's Event Coordinators: the people it names, who must also hold the role. */
	public static function coordinators_for( $event ) {
		$roster = self::coordinators();
		return array_values( array_intersect( (array) ( $event['coordinators'] ?? array() ), $roster ) );
	}

	/**
	 * Who may open an event's coordinator portal: an administrator, or someone holding the role
	 * who is named on that event. The portal shows what people actually typed, so it needs a
	 * sign-in — it is not a link to hand around.
	 */
	public static function can_coordinate( $event, $email ) {
		if ( ! $event ) {
			return false;
		}
		if ( self::is_admin( $email ) ) {
			return true;
		}
		return $email && in_array( $email, self::coordinators_for( $event ), true );
	}

	/** The events this person coordinates, for the portal's own picker. */
	public static function events_for( $email ) {
		return array_values( array_filter( QD_Store::all_events(), function ( $ev ) use ( $email ) {
			return self::can_coordinate( $ev, $email );
		} ) );
	}

	public static function require_event( $eid ) {
		$event = QD_Store::get_event( $eid );
		if ( ! $event ) {
			throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
		}
		if ( ! self::can_coordinate( $event, self::current_email() ) ) {
			throw new QD_Error( QD_App::t( 'err.youAreNotAnEvent' ) );
		}
		return $event;
	}

	/** A session's QA Facilitators: its own plus its event's. */
	public static function facilitators_for( $session ) {
		$out = array_values( (array) ( $session['moderators'] ?? array() ) );
		$ev  = ! empty( $session['eventId'] ) ? QD_Store::get_event( $session['eventId'] ) : null;
		foreach ( (array) ( $ev['moderators'] ?? array() ) as $email ) {
			if ( ! in_array( $email, $out, true ) ) {
				$out[] = $email;
			}
		}
		return $out;
	}

	public static function can_moderate( $session, $email ) {
		if ( ! $email ) {
			return false;
		}
		if ( self::is_admin( $email ) ) {
			return true;
		}
		return self::user_can_email( $email, 'qd_facilitate' ) && in_array( $email, self::facilitators_for( $session ), true );
	}

	public static function require_admin() {
		if ( ! current_user_can( 'qd_manage' ) ) {
			throw new QD_Error( QD_App::t( 'err.onlyAdministratorsCanDoThat' ) );
		}
		return self::current_email();
	}

	public static function require_session( $sid ) {
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			throw new QD_Error( 'Session not found.' );
		}
		if ( ! self::can_moderate( $session, self::current_email() ) ) {
			throw new QD_Error( QD_App::t( 'err.youAreNotAQa' ) );
		}
		return $session;
	}

	public static function sessions_for( $email ) {
		return array_values( array_filter( QD_Store::all_sessions(), function ( $s ) use ( $email ) {
			return self::can_moderate( $s, $email );
		} ) );
	}

	/**
	 * Adds a person: an existing WordPress user gets the role; anyone else gets a new account
	 * with the role and WordPress's own "set your password" email.
	 */
	public static function add_person( $role, $email ) {
		self::require_admin();
		$emails  = QD_Util::parse_emails( array( $email ) );
		$address = $emails[0] ?? '';
		if ( ! $address ) {
			throw new QD_Error( QD_App::t( 'err.enterAnEmailAddress' ) );
		}
		$wp_role = 'admin' === $role ? 'qd_admin' : ( 'coordinator' === $role ? 'qd_coordinator' : 'qd_facilitator' );
		$user    = get_user_by( 'email', $address );
		if ( $user ) {
			$user->add_role( $wp_role );
		} else {
			$login = sanitize_user( strstr( $address, '@', true ), true );
			$base  = $login ? $login : 'questiondesk';
			for ( $n = 2; username_exists( $login ) || '' === $login; $n++ ) {
				$login = $base . $n;
			}
			$id = wp_insert_user( array( 'user_login' => $login, 'user_email' => $address, 'user_pass' => wp_generate_password( 24 ), 'role' => $wp_role ) );
			if ( is_wp_error( $id ) ) {
				throw new QD_Error( $id->get_error_message() );
			}
			wp_new_user_notification( $id, null, 'user' );
		}
		QD_Activity::log( self::role_name( $role ) . ' added', null, $address );
		return QD_Admin::state();
	}

	/** Takes the role away (the WordPress account stays); a QA Facilitator also leaves every session and event. */
	/**
	 * The language one person reads the app in (appLanguage_ in server/strings.js). WordPress
	 * already has somewhere to keep it, so it lives on the user rather than in an option.
	 */
	public static function set_person_language( $email = '', $code = '' ) {
		self::require_admin();
		$address = strtolower( trim( (string) $email ) );
		$lang    = (string) $code;
		if ( $lang && QD_App::app_language_code( $lang ) !== $lang ) {
			throw new QD_Error( QD_App::t( 'err.notAnAppLanguage', array( 'code' => $lang ) ) );
		}
		$user = get_user_by( 'email', $address );
		if ( $user && $user->ID ) {
			if ( $lang && 'en' !== $lang ) {
				update_user_meta( $user->ID, 'qd_lang', $lang );
			} else {
				delete_user_meta( $user->ID, 'qd_lang' );   // English is the default
			}
		}
		QD_Activity::log( 'Person language set', null, $address . ': ' . ( $lang ? $lang : 'en' ) );
		return QD_Admin::state();
	}

	/** Everyone who reads the app in something other than English, by address. */
	public static function person_languages() {
		$out = array();
		foreach ( get_users( array( 'meta_key' => 'qd_lang', 'fields' => array( 'user_email' ) ) ) as $user ) {
			$lang = get_user_meta( get_user_by( 'email', $user->user_email )->ID, 'qd_lang', true );
			if ( $lang ) {
				$out[ strtolower( $user->user_email ) ] = $lang;
			}
		}
		return $out;
	}

	public static function remove_person( $role, $email ) {
		$me      = self::require_admin();
		$address = strtolower( trim( (string) $email ) );
		$user    = $address ? get_user_by( 'email', $address ) : false;
		if ( 'admin' === $role ) {
			if ( $address === self::owner_email() || ( $user && in_array( QD_App::t( 'admin.roleAdministrator' ), (array) $user->roles, true ) ) ) {
				throw new QD_Error( QD_App::t( 'wp.err.wordpressAdmins' ) );
			}
			if ( $address === $me ) {
				throw new QD_Error( QD_App::t( 'err.youCannotRemoveYourselfAsk' ) );
			}
			if ( $user ) {
				$user->remove_role( 'qd_admin' );
			}
		} elseif ( 'coordinator' === $role ) {
			if ( $user ) {
				$user->remove_role( 'qd_coordinator' );
			}
			QD_Util::with_lock( 'events', function () use ( $address ) {
				foreach ( QD_Store::all_events() as $ev ) {
					$list = (array) ( $ev['coordinators'] ?? array() );
					if ( in_array( $address, $list, true ) ) {
						$ev['coordinators'] = array_values( array_diff( $list, array( $address ) ) );
						QD_Store::save_event( $ev );
					}
				}
			} );
		} else {
			if ( $user ) {
				$user->remove_role( 'qd_facilitator' );
			}
			QD_Util::with_lock( 'sessions', function () use ( $address ) {
				foreach ( QD_Store::all_sessions() as $s ) {
					$list = (array) ( $s['moderators'] ?? array() );
					if ( in_array( $address, $list, true ) ) {
						$s['moderators'] = array_values( array_diff( $list, array( $address ) ) );
						QD_Store::save_session( $s );
					}
				}
				foreach ( QD_Store::all_events() as $ev ) {
					$list = (array) ( $ev['moderators'] ?? array() );
					if ( in_array( $address, $list, true ) ) {
						$ev['moderators'] = array_values( array_diff( $list, array( $address ) ) );
						QD_Store::save_event( $ev );
					}
				}
			} );
		}
		QD_Activity::log( self::role_name( $role ) . ' removed', null, $address );
		return QD_Admin::state();
	}
}
