<?php
/**
 * Sessions: validation and saving, order, activate/end/delete, links and room screen keys,
 * duplicating and archiving (sessions.js and parts of admin.js/operations.js).
 */

defined( 'ABSPATH' ) || exit;

class QD_Sessions {

	public static function save( $input ) {
		$me = QD_People::require_admin();
		self::save_as( (array) $input, $me, false );
		return QD_Admin::state();
	}

	/**
	 * Validates and stores a session from the form (or a CSV import). With $dry_run it only
	 * validates, raising the same problems a save would. Returns the session id (saveSessionAs_).
	 */
	public static function save_as( array $input, $me, $dry_run ) {
		$config = QD_App::data()['config'];
		$name   = QD_Util::clean_text( $input['name'] ?? '', 80 );
		if ( ! $name ) {
			throw new QD_Error( 'Give the session a name.' );
		}
		$access     = ( ( $input['access'] ?? '' ) === 'link' ) ? 'link' : 'room';
		$theme      = in_array( $input['theme'] ?? '', array( 'light', 'contrast' ), true ) ? $input['theme'] : 'dark';
		$max_length = (int) round( (float) ( $input['maxLength'] ?? 0 ) ?: $config['defaultMaxLength'] );
		if ( $max_length < 50 || $max_length > $config['maxLengthCeiling'] ) {
			throw new QD_Error( 'Question length must be between 50 and ' . $config['maxLengthCeiling'] . ' characters.' );
		}
		$roster     = QD_People::moderators();
		$moderators = array_values( array_intersect( array_map( 'strtolower', (array) ( $input['moderators'] ?? array() ) ), $roster ) );

		$start = self::optional_time( $input['scheduledStart'] ?? null, 'start' );
		$end   = self::optional_time( $input['scheduledEnd'] ?? null, 'end' );
		if ( $start && $end && $end <= $start ) {
			throw new QD_Error( 'The scheduled end must be after the start.' );
		}
		$before      = ! empty( $input['id'] ) ? QD_Store::get_session( $input['id'] ) : null;
		$same_minute = function ( $a, $b ) {
			return $a && $b && floor( $a / 60000 ) === floor( $b / 60000 );
		};
		if ( $end && $end <= QD_Util::now_ms() && ! ( $before && $same_minute( $before['scheduledEnd'] ?? null, $end ) ) ) {
			throw new QD_Error( 'The scheduled end has already passed. Saving it would end the session for good — check the date and AM/PM.' );
		}

		$cooldown = ( ! array_key_exists( 'cooldownSeconds', $input ) || '' === $input['cooldownSeconds'] || null === $input['cooldownSeconds'] )
			? $config['cooldownSeconds'] : (int) round( (float) $input['cooldownSeconds'] );
		if ( $cooldown < 0 || $cooldown > $config['cooldownCeiling'] ) {
			throw new QD_Error( 'Time between questions must be between 0 and ' . $config['cooldownCeiling'] . ' seconds.' );
		}
		$brand_accent = (string) ( $input['brandAccent'] ?? '' );
		if ( $brand_accent && ! preg_match( QD_Util::HEX_RE, $brand_accent ) ) {
			throw new QD_Error( 'Session accent color must look like #1b5e5a.' );
		}

		$prepared_list = null;
		if ( array_key_exists( 'prepared', $input ) && null !== $input['prepared'] ) {
			$lines = is_array( $input['prepared'] ) ? $input['prepared'] : preg_split( '/\r?\n/', (string) $input['prepared'] );
			if ( strlen( implode( '', $lines ) ) > $config['maxPrepared'] * $config['maxLengthCeiling'] ) {
				throw new QD_Error( 'That list of prepared questions is too long.' );
			}
			$prepared_list = array_values( array_filter( array_map( function ( $line ) {
				return trim( preg_replace( '/\s+/u', ' ', (string) $line ) );
			}, $lines ) ) );
			if ( count( $prepared_list ) > $config['maxPrepared'] ) {
				throw new QD_Error( 'Load at most ' . $config['maxPrepared'] . ' prepared questions per session.' );
			}
			foreach ( $prepared_list as $q ) {
				if ( mb_strlen( $q ) < 5 ) {
					throw new QD_Error( 'Prepared question is too short: ' . $q );
				}
				if ( mb_strlen( $q ) > $max_length ) {
					throw new QD_Error( 'A prepared question is longer than ' . $max_length . ' characters: ' . mb_substr( $q, 0, 60 ) . '…' );
				}
			}
		}

		$fields = array(
			'name'             => $name,
			'heading'          => QD_Util::clean_text( $input['heading'] ?? '', 120 ) ?: 'Questions for the panel',
			'access'           => $access,
			'theme'            => $theme,
			'maxLength'        => $max_length,
			'cooldownSeconds'  => $cooldown,
			'moderators'       => $moderators,
			'emailOnEnd'       => ! empty( $input['emailOnEnd'] ),
			'scheduledStart'   => $start,
			'scheduledEnd'     => $end,
			'brand'            => array( 'orgName' => QD_Util::clean_text( $input['brandOrgName'] ?? '', 80 ), 'accent' => strtolower( $brand_accent ) ),
			'translatePrepared' => ( $input['translatePrepared'] ?? true ) !== false,
			'roomQuestions'    => ! empty( $input['roomQuestions'] ),
			'guestPage'        => self::clean_guest_page_choice( $input['guestPage'] ?? null ),
			'eventId'          => (string) ( $input['eventId'] ?? '' ),
		);
		if ( $fields['eventId'] && ! QD_Store::get_event( $fields['eventId'] ) ) {
			throw new QD_Error( 'That event no longer exists.' );
		}
		if ( ! array_key_exists( 'guestPage', $input ) ) {
			unset( $fields['guestPage'] );
		}
		if ( ! array_key_exists( 'eventId', $input ) ) {
			unset( $fields['eventId'] );   // edits that don't mention it keep it
		}
		if ( $dry_run ) {
			return $input['id'] ?? null;
		}

		$saved_id = (string) ( $input['id'] ?? '' );
		if ( $saved_id ) {
			$was = QD_Store::get_session( $saved_id );
			$now = QD_Store::update_session( $saved_id, function ( &$s ) use ( $fields ) {
				if ( ( $s['scheduledStart'] ?? null ) !== $fields['scheduledStart'] ) {
					$s['scheduleStarted'] = false;
				}
				foreach ( $fields as $key => $value ) {
					$s[ $key ] = $value;
				}
				if ( empty( $s['eventId'] ) ) {
					unset( $s['eventId'] );
				}
				if ( 'link' === $s['access'] && empty( $s['linkKey'] ) ) {
					$s['linkKey'] = QD_Util::new_id( 16 );
				}
			} );
			$changed = $was ? QD_Activity::session_changes( $was, $now ) : '';
			if ( $changed || null !== $prepared_list ) {
				$details = array_filter( array( $changed, null !== $prepared_list ? 'prepared questions (' . count( $prepared_list ) . ')' : '' ) );
				QD_Activity::log( 'Session edited', $now, implode( ', ', $details ) );
			}
		} else {
			QD_Util::with_lock( 'sessions', function () use ( &$saved_id, $fields, $me ) {
				$session = $fields;
				if ( empty( $session['eventId'] ) ) {
					unset( $session['eventId'] );
				}
				$session['id']        = QD_Util::new_id( 8 );
				$session['linkKey']   = QD_Util::new_id( 16 );
				$session['screenKey'] = QD_Util::new_id( 16 );
				$session['status']    = 'inactive';
				$session['open']      = true;
				$session['created']   = QD_Util::now_ms();
				$session['createdBy'] = $me;
				$orders               = array_map( function ( $s ) {
					return isset( $s['order'] ) ? (int) $s['order'] : 0;
				}, QD_Store::all_sessions() );
				$session['order']     = $orders ? min( $orders ) - 1 : 0;   // new sessions on top
				QD_Store::save_session( $session );
				$saved_id = $session['id'];
			} );
			QD_Activity::log( 'Session created', QD_Store::get_session( $saved_id ), '' );
		}
		if ( null !== $prepared_list ) {
			QD_Questions::set_prepared( $saved_id, $prepared_list );
		}
		return $saved_id;
	}

	private static function optional_time( $value, $label ) {
		if ( null === $value || '' === $value ) {
			return null;
		}
		$ms = (float) $value;
		if ( ! is_finite( $ms ) || $ms <= 0 ) {
			throw new QD_Error( 'The scheduled ' . $label . ' is not a valid date and time.' );
		}
		return (int) round( $ms );
	}

	/** { room, slide, panel, url } from a stored or submitted choice (guestChoice_). */
	public static function guest_choice( $input ) {
		$input = is_array( $input ) ? $input : array();
		$all   = ( $input['mode'] ?? '' ) === 'wrapper';
		$room  = $all || ( true === ( $input['room'] ?? null ) );
		return array(
			'room'  => $room,
			'slide' => $all || ( true === ( $input['slide'] ?? null ) ),
			'panel' => $all || ( array_key_exists( 'panel', $input ) ? true === $input['panel'] : $room ),
			'url'   => (string) ( $input['url'] ?? '' ),
		);
	}

	private static function clean_guest_page_choice( $input ) {
		$g = self::guest_choice( $input );
		return array( 'room' => $g['room'], 'slide' => $g['slide'], 'panel' => $g['panel'], 'url' => '' );
	}

	// ------------------------------------------------------------ links

	/** The room screen key; sessions made before it existed get one when links are first made. */
	public static function screen_key( array $session ) {
		if ( empty( $session['screenKey'] ) ) {
			$saved = QD_Store::update_session( $session['id'], function ( &$s ) {
				if ( empty( $s['screenKey'] ) ) {
					$s['screenKey'] = QD_Util::new_id( 16 );
				}
			} );
			return (string) $saved['screenKey'];
		}
		return (string) $session['screenKey'];
	}

	public static function screen_key_valid( $session, $key ) {
		return ! empty( $session['screenKey'] ) && is_string( $key ) && $key === $session['screenKey'];
	}

	public static function links( array $session ) {
		$base = QD_Router::base_url();
		$key  = self::screen_key( $session );
		$id   = $session['id'];
		return array(
			'present'     => $base . '?view=present&s=' . $id . '&r=' . $key,
			'moderate'    => $base . '?view=moderate&s=' . $id,
			'panel'       => $base . '?view=panel&s=' . $id . '&r=' . $key,
			'slide'       => $base . '?view=present&s=' . $id . '&r=' . $key . '&layout=qr',
			'participant' => ( $session['access'] ?? '' ) === 'link' ? $base . '?s=' . $id . '&k=' . ( $session['linkKey'] ?? '' ) : null,
		);
	}

	// ------------------------------------------------------------ running a session

	public static function reorder( $ids ) {
		QD_People::require_admin();
		if ( ! is_array( $ids ) ) {
			throw new QD_Error( 'Send the sessions in their new order.' );
		}
		self::reorder_ids( $ids );
		return QD_Admin::state();
	}

	/** Puts these sessions first, in this order; the rest keep their order after them. */
	public static function reorder_ids( array $ids ) {
		QD_Util::with_lock( 'sessions', function () use ( $ids ) {
			$by_id = array();
			foreach ( QD_Store::all_sessions() as $s ) {
				$by_id[ $s['id'] ] = $s;
			}
			$ordered = array();
			foreach ( $ids as $id ) {
				$id = (string) $id;
				if ( isset( $by_id[ $id ] ) && ! isset( $ordered[ $id ] ) ) {
					$ordered[ $id ] = $by_id[ $id ];
				}
			}
			foreach ( $by_id as $id => $s ) {
				if ( ! isset( $ordered[ $id ] ) ) {
					$ordered[ $id ] = $s;
				}
			}
			$i = 0;
			foreach ( $ordered as $s ) {
				if ( ( $s['order'] ?? null ) !== $i ) {
					$s['order'] = $i;
					QD_Store::save_session( $s );
				}
				$i++;
			}
		} );
	}

	public static function set_active( $sid, $active ) {
		QD_People::require_admin();
		$session = QD_Store::update_session( $sid, function ( &$s ) use ( $active ) {
			if ( 'ended' === ( $s['status'] ?? '' ) ) {
				throw new QD_Error( 'This session has ended and cannot be reopened.' );
			}
			$s['status'] = $active ? 'active' : 'inactive';
			if ( $active && empty( $s['started'] ) ) {
				$s['started'] = QD_Util::now_ms();
			}
		} );
		QD_Activity::log( $active ? 'Session activated' : 'Session deactivated', $session, '' );
		return QD_Admin::state();
	}

	/** which: 'screen' replaces the room screen (and slide) link; otherwise the participant link. */
	public static function regenerate_link( $sid, $which ) {
		QD_People::require_admin();
		$session = QD_Store::update_session( $sid, function ( &$s ) use ( $which ) {
			if ( 'screen' === $which ) {
				$s['screenKey'] = QD_Util::new_id( 16 );
			} else {
				$s['linkKey'] = QD_Util::new_id( 16 );
			}
		} );
		QD_Activity::log( 'screen' === $which ? 'Room screen link replaced' : 'Participant link replaced', $session, '' );
		return QD_Admin::state();
	}

	public static function end( $sid, $typed_name ) {
		QD_People::require_admin();
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			throw new QD_Error( 'Session not found.' );
		}
		QD_Util::require_typed_name( $session, $typed_name );
		$result          = self::end_session( $sid );
		$result['state'] = QD_Admin::state();
		return $result;
	}

	/**
	 * Ends a session for good. The final grouping pass and the summary email come with phases 4
	 * and 5; for now it closes intake and clears the room code.
	 */
	public static function end_session( $sid ) {
		$session = QD_Store::update_session( $sid, function ( &$s ) {
			if ( 'ended' === ( $s['status'] ?? '' ) ) {
				throw new QD_Error( 'This session has already ended.' );
			}
			$s['status']       = 'ended';
			$s['open']         = false;
			$s['ended']        = QD_Util::now_ms();
			$s['nowAnswering'] = null;
		} );
		QD_Tokens::clear_room_token( $sid );
		QD_Activity::log( 'Session ended', $session, '' );
		return array( 'emailed' => 0, 'note' => '' );
	}

	public static function delete( $sid, $typed_name ) {
		QD_People::require_admin();
		$session = QD_Store::get_session( $sid );
		if ( ! $session ) {
			throw new QD_Error( 'Session not found.' );
		}
		if ( 'active' === ( $session['status'] ?? '' ) ) {
			throw new QD_Error( 'Deactivate or end the session before deleting it.' );
		}
		QD_Util::require_typed_name( $session, $typed_name );
		QD_Settings::clear_logo( $sid );
		QD_Questions::delete_for_session( $sid );
		QD_Store::delete_session_row( $sid );
		QD_Tokens::clear_room_token( $sid );
		QD_Activity::log( 'Session deleted', $session, 'with its questions, topics and votes' );
		return QD_Admin::state();
	}

	// ------------------------------------------------------------ duplicating and archiving

	/** The form input that would save this session as it is (sessionInput_). */
	public static function session_input( array $s ) {
		$own = (array) ( $s['brand'] ?? array() );
		return array(
			'id'               => $s['id'],
			'name'             => $s['name'] ?? '',
			'heading'          => $s['heading'] ?? '',
			'access'           => $s['access'] ?? 'room',
			'theme'            => $s['theme'] ?? 'dark',
			'maxLength'        => $s['maxLength'] ?? null,
			'cooldownSeconds'  => $s['cooldownSeconds'] ?? null,
			'moderators'       => array_values( (array) ( $s['moderators'] ?? array() ) ),
			'emailOnEnd'       => ! empty( $s['emailOnEnd'] ),
			'translatePrepared' => ( $s['translatePrepared'] ?? true ) !== false,
			'roomQuestions'    => ! empty( $s['roomQuestions'] ),
			'scheduledStart'   => $s['scheduledStart'] ?? null,
			'scheduledEnd'     => $s['scheduledEnd'] ?? null,
			'brandOrgName'     => $own['orgName'] ?? '',
			'brandAccent'      => $own['accent'] ?? '',
			'guestPage'        => $s['guestPage'] ?? null,
			'eventId'          => $s['eventId'] ?? '',
		);
	}

	public static function duplicate( $sid, $event_id = null ) {
		$me = QD_People::require_admin();
		$id = self::duplicate_session( $sid, $event_id, $me, false );
		QD_Activity::log( 'Session duplicated', QD_Store::get_session( $id ), 'from "' . QD_Store::get_session( $sid )['name'] . '"' );
		$state                  = QD_Admin::state();
		$state['newSessionId'] = $id;
		return $state;
	}

	public static function duplicate_session( $sid, $event_id, $me, $keep_name ) {
		$src = QD_Store::get_session( $sid );
		if ( ! $src ) {
			throw new QD_Error( 'Session not found.' );
		}
		$input = self::session_input( $src );
		unset( $input['id'] );
		$input['name']           = $keep_name ? $src['name'] : QD_Util::clean_text( $src['name'] . ' (copy)', 80 );
		$input['scheduledStart'] = null;
		$input['scheduledEnd']   = null;
		if ( null !== $event_id ) {
			$input['eventId'] = (string) $event_id;
		}
		$input['prepared'] = QD_Questions::prepared_for( $sid );
		$id                = self::save_as( $input, $me, false );
		$logo_id           = QD_Settings::logo_id( $sid );
		if ( $logo_id ) {
			QD_Store::update_session( $id, function ( &$s ) use ( $logo_id ) {
				$s['logoId']  = $logo_id;
				$s['hasLogo'] = true;
			} );
		}
		return $id;
	}

	public static function archive( $sid ) {
		QD_People::require_admin();
		global $wpdb;
		$session = QD_Store::get_session( $sid );
		if ( ! $session || 'ended' !== ( $session['status'] ?? '' ) ) {
			throw new QD_Error( 'Only ended sessions can be archived.' );
		}
		$votes = $wpdb->get_results( $wpdb->prepare( 'SELECT vote_key, votes FROM ' . QD_Install::table( 'votes' ) . ' WHERE session_id = %s', $sid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$map   = array();
		foreach ( $votes as $row ) {
			$map[ $row->vote_key ] = (int) $row->votes;
		}
		$wpdb->replace(
			QD_Install::table( 'archive' ),
			array( 'session_id' => $sid, 'archived' => QD_Util::now_ms(), 'session' => wp_json_encode( $session ), 'votes' => wp_json_encode( $map ) )
		);
		QD_Store::delete_session_row( $sid );
		$wpdb->delete( QD_Install::table( 'votes' ), array( 'session_id' => $sid ) );
		QD_Tokens::clear_room_token( $sid );
		QD_Activity::log( 'Session archived', $session, '' );
		return QD_Admin::state();
	}

	public static function restore( $sid ) {
		QD_People::require_admin();
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT session, votes FROM ' . QD_Install::table( 'archive' ) . ' WHERE session_id = %s', $sid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		if ( ! $row ) {
			throw new QD_Error( 'Archived session not found.' );
		}
		if ( QD_Store::get_session( $sid ) ) {
			throw new QD_Error( 'That session is already restored.' );
		}
		$session = QD_Util::json_array( $row->session );
		if ( ! empty( $session['eventId'] ) && ! QD_Store::get_event( $session['eventId'] ) ) {
			unset( $session['eventId'] );   // its event was deleted
		}
		QD_Store::save_session( $session );
		foreach ( QD_Util::json_array( $row->votes ) as $key => $count ) {
			$wpdb->replace( QD_Install::table( 'votes' ), array( 'session_id' => $sid, 'vote_key' => $key, 'votes' => (int) $count ) );
		}
		$wpdb->delete( QD_Install::table( 'archive' ), array( 'session_id' => $sid ) );
		QD_Activity::log( 'Session restored', $session, '' );
		return QD_Admin::state();
	}

	public static function archived() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT session_id, archived, session FROM ' . QD_Install::table( 'archive' ) . ' ORDER BY archived DESC' ); // phpcs:ignore WordPress.DB.PreparedSQL
		return array_map( function ( $row ) {
			$session = QD_Util::json_array( $row->session );
			return array(
				'id'       => $row->session_id,
				'name'     => (string) ( $session['name'] ?? '' ),
				'eventId'  => (string) ( $session['eventId'] ?? '' ),
				'ended'    => isset( $session['ended'] ) ? (int) $session['ended'] : null,
				'archived' => (int) $row->archived,
			);
		}, $rows );
	}
}
