<?php
/** Events: a parent for sessions, with their own branding, languages and QA Facilitators (events.js). */

defined( 'ABSPATH' ) || exit;

class QD_Events {

	public static function save( $input ) {
		$me    = QD_People::require_admin();
		$input = (array) $input;
		$name  = QD_Util::clean_text( $input['name'] ?? '', 80 );
		if ( ! $name ) {
			throw new QD_Error( QD_App::t( 'err.giveTheEventAName' ) );
		}
		$color = function ( $value, $label ) {
			$v = trim( (string) $value );
			if ( '' !== $v && ! preg_match( QD_Util::HEX_RE, $v ) ) {
				throw new QD_Error( QD_App::t( 'err.colorFormat', array( 'label' => $label ) ) );
			}
			return strtolower( $v );
		};
		$has_languages = array_key_exists( 'languages', $input );
		$languages     = ( ! $has_languages || null === $input['languages'] || ( is_array( $input['languages'] ) && ! $input['languages'] ) )
			? null : QD_Settings::clean_languages( $input['languages'] );
		$on_list    = function ( $key, $roster ) use ( $input ) {
			return array_key_exists( $key, $input )
				? array_values( array_intersect( array_map( 'strtolower', (array) $input[ $key ] ), $roster ) ) : null;
		};
		$moderators   = $on_list( 'moderators', QD_People::moderators() );
		$coordinators = $on_list( 'coordinators', QD_People::coordinators() );
		$brand = array(
			'orgName'     => QD_Util::clean_text( $input['orgName'] ?? '', 80 ),
			'accent'      => $color( $input['accent'] ?? '', 'The accent' ),
			'welcome'     => QD_Util::clean_text( $input['welcome'] ?? '', 200 ),
			'footer'      => QD_Util::clean_text( $input['footer'] ?? '', 160 ),
			'roomBgDark'  => $color( $input['roomBgDark'] ?? '', QD_App::t( 'err.label.darkBackground' ) ),
			'roomBgLight' => $color( $input['roomBgLight'] ?? '', QD_App::t( 'err.label.lightBackground' ) ),
		);

		$id = (string) ( $input['id'] ?? '' );
		QD_Util::with_lock( 'events', function () use ( &$id, $name, $brand, $languages, $moderators, $coordinators, $has_languages, $me ) {
			if ( $id ) {
				$ev = QD_Store::get_event( $id );
				if ( ! $ev ) {
					throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
				}
				$ev['name']  = $name;
				$ev['brand'] = $brand;
				if ( $has_languages ) {
					$ev['languages'] = $languages;
				}
				if ( null !== $moderators ) {
					$ev['moderators'] = $moderators;
				}
				if ( null !== $coordinators ) {
					$ev['coordinators'] = $coordinators;
				}
				QD_Store::save_event( $ev );
				QD_Activity::log( 'Event edited', array( 'id' => $id, 'eventName' => $name ), '' );
			} else {
				$id = QD_Util::new_id( 8 );
				QD_Store::save_event( array(
					'id'         => $id,
					'name'       => $name,
					'brand'      => $brand,
					'languages'  => $languages,
					'moderators'   => $moderators ? $moderators : array(),
					'coordinators' => $coordinators ? $coordinators : array(),
					'hasLogo'    => false,
					'created'    => QD_Util::now_ms(),
					'createdBy'  => $me,
					'order'      => self::next_order(),
				) );
				QD_Activity::log( 'Event created', array( 'id' => $id, 'eventName' => $name ), '' );
			}
		} );

		$state                 = QD_Admin::state();
		$state['savedEventId'] = $id;
		return $state;
	}

	/** New events go on top. */
	private static function next_order() {
		$orders = array_map( function ( $e ) {
			return isset( $e['order'] ) ? (int) $e['order'] : 0;
		}, QD_Store::all_events() );
		return $orders ? min( $orders ) - 1 : 0;
	}

	public static function reorder( $ids ) {
		QD_People::require_admin();
		if ( ! is_array( $ids ) ) {
			throw new QD_Error( QD_App::t( 'err.sendTheEventsInTheir' ) );
		}
		QD_Util::with_lock( 'events', function () use ( $ids ) {
			$by_id = array();
			foreach ( QD_Store::all_events() as $ev ) {
				$by_id[ $ev['id'] ] = $ev;
			}
			$ordered = array();
			foreach ( $ids as $id ) {
				$id = (string) $id;
				if ( isset( $by_id[ $id ] ) ) {
					$ordered[ $id ] = $by_id[ $id ];
				}
			}
			foreach ( $by_id as $id => $ev ) {
				if ( ! isset( $ordered[ $id ] ) ) {
					$ordered[ $id ] = $ev;
				}
			}
			$i = 0;
			foreach ( $ordered as $ev ) {
				if ( ( $ev['order'] ?? null ) !== $i ) {
					$ev['order'] = $i;
					QD_Store::save_event( $ev );
				}
				$i++;
			}
		} );
		return QD_Admin::state();
	}

	/** Deletes an event; its sessions stay and simply leave it. */
	public static function delete( $eid, $typed_name ) {
		QD_People::require_admin();
		$ev = QD_Store::get_event( $eid );
		if ( ! $ev ) {
			throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
		}
		QD_Util::require_typed_name( $ev, $typed_name, 'event' );
		QD_Settings::clear_logo( 'event:' . $eid );
		QD_Util::with_lock( 'events', function () use ( $eid ) {
			foreach ( QD_Store::all_sessions() as $s ) {
				if ( ( $s['eventId'] ?? '' ) === $eid ) {
					unset( $s['eventId'] );
					QD_Store::save_session( $s );
				}
			}
			QD_Store::delete_event_row( $eid );
		} );
		QD_Activity::log( 'Event deleted', array( 'id' => $eid, 'eventName' => $ev['name'] ), 'its sessions were kept' );
		return QD_Admin::state();
	}

	public static function save_logo( $eid, $data_url ) {
		QD_People::require_admin();
		if ( ! QD_Store::get_event( $eid ) ) {
			throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
		}
		return QD_Settings::save_logo( $data_url, 'event:' . $eid );
	}

	public static function remove_logo( $eid ) {
		QD_People::require_admin();
		if ( ! QD_Store::get_event( $eid ) ) {
			throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
		}
		return QD_Settings::remove_logo( 'event:' . $eid );
	}

	public static function get_logo( $eid ) {
		QD_People::require_admin();
		return QD_Settings::logo_url( 'event:' . $eid );
	}

	/** A copy of an event (branding, languages, logo, QA Facilitators) and of all its sessions. */
	public static function duplicate( $eid ) {
		$me = QD_People::require_admin();
		$ev = QD_Store::get_event( $eid );
		if ( ! $ev ) {
			throw new QD_Error( QD_App::t( 'err.eventNotFound' ) );
		}
		$copy_id = QD_Util::new_id( 8 );
		QD_Store::save_event( array(
			'id'         => $copy_id,
			'name'       => QD_Util::clean_text( $ev['name'] . ' (copy)', 80 ),
			'brand'      => (array) ( $ev['brand'] ?? array() ),
			'languages'  => $ev['languages'] ?? null,
			'moderators'   => array_values( (array) ( $ev['moderators'] ?? array() ) ),
			'coordinators' => array_values( (array) ( $ev['coordinators'] ?? array() ) ),
			'hasLogo'    => false,
			'logoId'     => 0,
			'created'    => QD_Util::now_ms(),
			'createdBy'  => $me,
			'order'      => self::next_order(),
		) );
		$logo_id = QD_Settings::logo_id( 'event:' . $eid );
		if ( $logo_id ) {
			$copy = QD_Store::get_event( $copy_id );
			// Both events point at the same Media Library image; deleting one keeps the other's.
			$copy['logoId']  = $logo_id;
			$copy['hasLogo'] = true;
			QD_Store::save_event( $copy );
		}
		$ids = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ( $s['eventId'] ?? '' ) === $eid && empty( $s['loadTest'] ) ) {
				$ids[] = QD_Sessions::duplicate_session( $s['id'], $copy_id, $me, true );
			}
		}
		QD_Activity::log( 'Event duplicated', array( 'id' => $copy_id, 'eventName' => QD_Store::get_event( $copy_id )['name'] ), 'from "' . $ev['name'] . '" with ' . count( $ids ) . ' sessions' );
		$state                 = QD_Admin::state();
		$state['savedEventId'] = $copy_id;
		return $state;
	}
}
