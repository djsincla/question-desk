<?php
/**
 * Sessions CSV export and import (csv.js). The columns and the time format come from the
 * shared data/app.json, built from Code.js, so a file exported by either version imports into
 * the other unchanged.
 */

defined( 'ABSPATH' ) || exit;

class QD_Csv {

	public static function init() {
		QD_Api::register( 'exportSessionsCsv', array( __CLASS__, 'export_sessions' ), 'manage' );
		QD_Api::register( 'importSessionsCsv', array( __CLASS__, 'import_sessions' ), 'manage' );
	}

	/** [[header, key], …] shared with the Apps Script version. */
	public static function columns() {
		return QD_App::data()['sessionCsv'];
	}

	public static function time_format() {
		// The Apps Script pattern (yyyy-MM-dd HH:mm) as PHP writes it.
		return str_replace( array( 'yyyy', 'MM', 'dd', 'HH', 'mm' ), array( 'Y', 'm', 'd', 'H', 'i' ), QD_App::data()['csvTimeFormat'] );
	}

	/** A cell, with a leading =, +, - or @ quoted so no spreadsheet runs it (csvCell_). */
	public static function cell( $value ) {
		$text = (string) $value;
		if ( preg_match( '/^[=+\-@]/', $text ) ) {
			$text = "'" . $text;
		}
		return '"' . str_replace( '"', '""', $text ) . '"';
	}

	public static function lines( array $rows ) {
		$out = array();
		foreach ( $rows as $row ) {
			$out[] = implode( ',', array_map( array( __CLASS__, 'cell' ), $row ) );
		}
		return implode( "\r\n", $out );
	}

	// ------------------------------------------------------------ export

	public static function export_sessions() {
		QD_People::require_admin();
		$prepared = QD_Questions::prepared();
		$zone     = wp_timezone_string();
		$yes_no   = function ( $on ) {
			return $on ? 'yes' : 'no';
		};
		$time     = function ( $ms ) {
			return $ms ? wp_date( self::time_format(), (int) round( $ms / 1000 ) ) : '';
		};

		$rows = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			if ( ! empty( $s['loadTest'] ) ) {
				continue;
			}
			$guest  = QD_Sessions::guest_choice( $s['guestPage'] ?? null );
			$own    = (array) ( $s['brand'] ?? array() );
			$values = array(
				'event'             => QD_Store::event_name( $s ),
				'name'              => $s['name'],
				'heading'           => $s['heading'] ?? '',
				'access'            => $s['access'],
				'theme'             => $s['theme'] ?? 'dark',
				'roomQuestions'     => $yes_no( ! empty( $s['roomQuestions'] ) ),
				'cooldownSeconds'   => QD_Participants::cooldown_for( $s ),
				'maxLength'         => $s['maxLength'] ?? QD_App::config( 'defaultMaxLength' ),
				'emailOnEnd'        => $yes_no( ! empty( $s['emailOnEnd'] ) ),
				'scheduledStart'    => $time( $s['scheduledStart'] ?? null ),
				'scheduledEnd'      => $time( $s['scheduledEnd'] ?? null ),
				'moderators'        => implode( '; ', (array) ( $s['moderators'] ?? array() ) ),
				'guestRoom'         => $yes_no( $guest['room'] ),
				'guestSlide'        => $yes_no( $guest['slide'] ),
				'guestPanel'        => $yes_no( $guest['panel'] ),
				'guestUrl'          => $guest['url'],
				'brandOrgName'      => $own['orgName'] ?? '',
				'brandAccent'       => $own['accent'] ?? '',
				'prepared'          => implode( "\n", $prepared[ $s['id'] ] ?? array() ),
				'translatePrepared' => $yes_no( false !== ( $s['translatePrepared'] ?? true ) ),
				'status'            => $s['status'],
			);
			$row = array();
			foreach ( self::columns() as $column ) {
				$row[] = $values[ $column[1] ] ?? '';
			}
			$rows[] = $row;
		}
		$header = array();
		foreach ( self::columns() as $column ) {
			$header[] = in_array( $column[1], array( 'scheduledStart', 'scheduledEnd' ), true ) ? $column[0] . ' (' . $zone . ')' : $column[0];
		}
		QD_Activity::log( 'Sessions exported', null, count( $rows ) . ' sessions' );
		return array(
			'filename' => 'question-desk-sessions-' . wp_date( 'Y-m-d' ) . '.csv',
			'csv'      => "\u{FEFF}" . self::lines( array_merge( array( $header ), $rows ) ),
			'count'    => count( $rows ),
		);
	}

	// ------------------------------------------------------------ reading a file

	/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks (parseCsv_). */
	public static function parse( $text ) {
		$text   = preg_replace( '/^\x{FEFF}/u', '', (string) $text );
		$rows   = array();
		$row    = array();
		$field  = '';
		$quoted = false;
		$length = strlen( $text );
		for ( $i = 0; $i < $length; $i++ ) {
			$ch = $text[ $i ];
			if ( $quoted ) {
				if ( '"' === $ch ) {
					if ( isset( $text[ $i + 1 ] ) && '"' === $text[ $i + 1 ] ) {
						$field .= '"';
						$i++;
					} else {
						$quoted = false;
					}
				} else {
					$field .= $ch;
				}
			} elseif ( '"' === $ch ) {
				$quoted = true;
			} elseif ( ',' === $ch ) {
				$row[] = $field;
				$field = '';
			} elseif ( "\n" === $ch || "\r" === $ch ) {
				if ( "\r" === $ch && isset( $text[ $i + 1 ] ) && "\n" === $text[ $i + 1 ] ) {
					$i++;
				}
				$row[] = $field;
				$rows[] = $row;
				$row    = array();
				$field  = '';
			} else {
				$field .= $ch;
			}
		}
		if ( '' !== $field || $row ) {
			$row[]  = $field;
			$rows[] = $row;
		}
		return array_values( array_filter( $rows, function ( $r ) {
			foreach ( $r as $value ) {
				if ( '' !== trim( (string) $value ) ) {
					return true;
				}
			}
			return false;
		} ) );
	}

	/** "2026-10-03 18:30", "2026-10-03T18:30" or "10/3/2026 6:30 PM" in the site's time zone. */
	public static function read_time( $value, $label ) {
		$v = trim( (string) $value );
		if ( '' === $v ) {
			return null;
		}
		if ( preg_match( '/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/', $v, $m ) ) {
			list( , $y, $mo, $d, $h, $mi ) = array_map( 'intval', $m );
		} elseif ( preg_match( '#^(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$#', $v, $m ) ) {
			$mo = (int) $m[1];
			$d  = (int) $m[2];
			$y  = (int) $m[3];
			$h  = (int) $m[4];
			$mi = (int) $m[5];
			if ( ! empty( $m[6] ) ) {
				if ( $h < 1 || $h > 12 ) {
					throw new QD_Error( $label . ' "' . $v . '" has an hour that doesn\'t fit AM/PM.' );
				}
				$h = ( $h % 12 ) + ( preg_match( '/p/i', $m[6] ) ? 12 : 0 );
			}
		} else {
			throw new QD_Error( $label . ' "' . $v . '" is not a date and time like 2026-10-03 18:30.' );
		}
		if ( $mo < 1 || $mo > 12 || $d < 1 || $d > 31 || $h > 23 || $mi > 59 ) {
			throw new QD_Error( $label . ' "' . $v . '" is not a real date and time.' );
		}
		$when = new DateTimeImmutable( sprintf( '%04d-%02d-%02d %02d:%02d', $y, $mo, $d, $h, $mi ), wp_timezone() );
		return $when->getTimestamp() * 1000;
	}

	public static function read_yes( $value, $label, $fallback ) {
		$v = strtolower( trim( (string) $value ) );
		if ( '' === $v ) {
			return $fallback;
		}
		if ( preg_match( '/^(yes|y|true|1|x)$/', $v ) ) {
			return true;
		}
		if ( preg_match( '/^(no|n|false|0)$/', $v ) ) {
			return false;
		}
		throw new QD_Error( $label . ' should be yes or no, not "' . $value . '".' );
	}

	/** The duplicate key: name, plus start and end when either is set (sessionKey_). */
	public static function session_key( $name, $start, $end ) {
		$n      = strtolower( trim( preg_replace( '/\s+/u', ' ', (string) $name ) ) );
		$minute = function ( $ms ) {
			return $ms ? (string) floor( $ms / 60000 ) : '';
		};
		return ( $start || $end ) ? $n . '|' . $minute( $start ) . '|' . $minute( $end ) : $n;
	}

	// ------------------------------------------------------------ import

	/**
	 * Checks ($dry_run) or imports sessions from CSV text. $options: { duplicates: update|skip }.
	 * Each row is validated by the same code the session form uses, so check and import agree.
	 */
	public static function import_sessions( $text = '', $options = array(), $dry_run = true ) {
		$me           = QD_People::require_admin();
		$on_duplicate = ( ( (array) $options )['duplicates'] ?? '' ) === 'skip' ? 'skip' : 'update';
		if ( strlen( (string) $text ) > 2000000 ) {
			throw new QD_Error( 'That file is too large to import.' );
		}
		$table = self::parse( $text );
		if ( ! $table ) {
			throw new QD_Error( 'The file is empty.' );
		}
		$max = (int) QD_App::config( 'maxImportRows' );
		if ( count( $table ) - 1 > $max ) {
			throw new QD_Error( 'Import at most ' . $max . ' sessions at a time.' );
		}

		// Columns by header name, forgiving case, spacing and the time zone suffix.
		$norm  = function ( $header ) {
			return strtolower( preg_replace( '/[^a-z]/i', '', preg_replace( '/\(.*?\)/', '', (string) $header ) ) );
		};
		$known = array();
		foreach ( self::columns() as $column ) {
			$known[ $norm( $column[0] ) ] = $column[1];
		}
		$columns = array();
		foreach ( $table[0] as $header ) {
			$columns[] = $known[ $norm( $header ) ] ?? null;
		}
		if ( ! in_array( 'name', $columns, true ) ) {
			throw new QD_Error( 'The file needs a "Session" column. Export sessions first to get the format.' );
		}

		$roster   = QD_People::moderators();
		$existing = array();
		foreach ( QD_Store::all_sessions() as $s ) {
			$existing[ self::session_key( $s['name'], $s['scheduledStart'] ?? null, $s['scheduledEnd'] ?? null ) ] = $s;
		}
		$events_by_name = array();
		foreach ( QD_Store::all_events() as $ev ) {
			$events_by_name[ strtolower( trim( $ev['name'] ) ) ] = $ev;
		}
		$seen       = array();
		$new_events = array();
		$result     = array( 'rows' => array(), 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0, 'events' => array() );
		$created    = array();
		$unquote    = function ( $v ) {
			return preg_match( '/^\'[=+\-@]/', $v ) ? substr( $v, 1 ) : $v;   // undo the cell guard
		};
		if ( ! $dry_run ) {
			QD_Activity::$via = 'CSV import';
		}

		foreach ( array_slice( $table, 1 ) as $i => $cells ) {
			$row_number = $i + 2;
			$get        = array();
			foreach ( $columns as $c => $key ) {
				if ( $key ) {
					$get[ $key ] = $unquote( (string) ( $cells[ $c ] ?? '' ) );
				}
			}
			$has = function ( $key ) use ( $get ) {
				return array_key_exists( $key, $get );
			};
			$out = array(
				'row'      => $row_number,
				'event'    => trim( $get['event'] ?? '' ),
				'name'     => trim( $get['name'] ?? '' ),
				'action'   => '',
				'errors'   => array(),
				'warnings' => array(),
			);
			try {
				if ( '' === $out['name'] ) {
					throw new QD_Error( 'No session name.' );
				}
				$start = $has( 'scheduledStart' ) ? self::read_time( $get['scheduledStart'], 'Scheduled start' ) : false;
				$end   = $has( 'scheduledEnd' ) ? self::read_time( $get['scheduledEnd'], 'Scheduled end' ) : false;
				$key   = self::session_key( $out['name'], false === $start ? null : $start, false === $end ? null : $end );
				if ( isset( $seen[ $key ] ) ) {
					throw new QD_Error( 'The same session is already on row ' . $seen[ $key ] . '.' );
				}
				$seen[ $key ] = $row_number;
				$match        = $existing[ $key ] ?? null;

				if ( $match && 'skip' === $on_duplicate ) {
					$out['action']     = 'skip';
					$out['warnings'][] = 'Already exists; skipped.';
					$result['skipped']++;
					$result['rows'][] = $out;
					continue;
				}
				if ( $match && 'ended' === $match['status'] ) {
					$out['action']     = 'skip';
					$out['warnings'][] = 'Already exists and has ended; ended sessions can\'t be changed.';
					$result['skipped']++;
					$result['rows'][] = $out;
					continue;
				}

				// Start from the session as it is, so missing columns change nothing.
				$input         = $match ? QD_Sessions::session_input( $match ) : array( 'name' => $out['name'], 'emailOnEnd' => true );
				$input['name'] = $out['name'];
				if ( $has( 'heading' ) ) {
					$input['heading'] = $get['heading'];
				}
				if ( $has( 'access' ) ) {
					$a = strtolower( trim( $get['access'] ) );
					if ( $a && 'room' !== $a && 'link' !== $a ) {
						throw new QD_Error( 'How people join should be room or link, not "' . $get['access'] . '".' );
					}
					if ( $a ) {
						$input['access'] = $a;
					}
				}
				if ( $has( 'theme' ) ) {
					$t = strtolower( trim( $get['theme'] ) );
					if ( $t && ! in_array( $t, array( 'dark', 'light', 'contrast' ), true ) ) {
						throw new QD_Error( 'Theme should be dark, light or contrast, not "' . $get['theme'] . '".' );
					}
					if ( $t ) {
						$input['theme'] = $t;
					}
				}
				if ( $has( 'cooldownSeconds' ) && '' !== trim( $get['cooldownSeconds'] ) ) {
					$input['cooldownSeconds'] = trim( $get['cooldownSeconds'] );
				}
				if ( $has( 'maxLength' ) && '' !== trim( $get['maxLength'] ) ) {
					$input['maxLength'] = trim( $get['maxLength'] );
				}
				if ( $has( 'emailOnEnd' ) ) {
					$input['emailOnEnd'] = self::read_yes( $get['emailOnEnd'], 'Email summary', ! empty( $input['emailOnEnd'] ) );
				}
				if ( false !== $start ) {
					$input['scheduledStart'] = $start;
				}
				if ( false !== $end ) {
					$input['scheduledEnd'] = $end;
				}
				if ( $has( 'moderators' ) ) {
					$listed  = QD_Util::parse_emails( $get['moderators'] );
					$missing = array_values( array_diff( $listed, $roster ) );
					if ( $missing ) {
						$out['warnings'][] = 'Not on the QA Facilitator list, so not added: ' . implode( ', ', $missing ) . '. Add them on the People tab.';
					}
					$input['moderators'] = array_values( array_intersect( $listed, $roster ) );
				}
				if ( $has( 'guestRoom' ) || $has( 'guestSlide' ) || $has( 'guestPanel' ) || $has( 'guestUrl' ) ) {
					$g                  = QD_Sessions::guest_choice( $input['guestPage'] ?? null );
					$input['guestPage'] = array(
						'room'  => self::read_yes( $get['guestRoom'] ?? '', 'Guest page for room screen', $g['room'] ),
						'slide' => self::read_yes( $get['guestSlide'] ?? '', 'Guest page for slide', $g['slide'] ),
						'panel' => self::read_yes( $get['guestPanel'] ?? '', 'Guest page for panelist view', $g['panel'] ),
						'url'   => $has( 'guestUrl' ) ? trim( $get['guestUrl'] ) : $g['url'],
					);
				}
				if ( $has( 'roomQuestions' ) ) {
					$input['roomQuestions'] = self::read_yes( $get['roomQuestions'], 'Room screen lists questions', ! empty( $input['roomQuestions'] ) );
				}
				if ( $has( 'translatePrepared' ) ) {
					$input['translatePrepared'] = self::read_yes( $get['translatePrepared'], 'Translate prepared questions', false !== ( $input['translatePrepared'] ?? true ) );
				}
				if ( $has( 'brandOrgName' ) ) {
					$input['brandOrgName'] = $get['brandOrgName'];
				}
				if ( $has( 'brandAccent' ) ) {
					$input['brandAccent'] = strtolower( trim( $get['brandAccent'] ) );
				}
				if ( $has( 'prepared' ) ) {
					$lines   = array_values( array_filter( array_map( 'trim', preg_split( '/\r?\n/', $get['prepared'] ) ) ) );
					$current = $match ? QD_Questions::prepared_for( $match['id'] ) : array();
					if ( implode( "\n", $lines ) !== implode( "\n", $current ) ) {
						$input['prepared'] = $lines;   // an unchanged list keeps its ids
					}
				}
				if ( $has( 'event' ) ) {
					$event_name = $out['event'];
					if ( ! $event_name ) {
						$input['eventId'] = '';
					} elseif ( isset( $events_by_name[ strtolower( $event_name ) ] ) ) {
						$input['eventId'] = $events_by_name[ strtolower( $event_name ) ]['id'];
					} else {
						if ( ! isset( $new_events[ strtolower( $event_name ) ] ) ) {
							$new_events[ strtolower( $event_name ) ] = $event_name;
							$result['events'][]                      = $event_name;
						}
						$input['eventId']  = '';   // made below, when importing for real
						$out['warnings'][] = 'New event "' . $event_name . '" will be created.';
					}
				}

				$out['action'] = $match ? 'update' : 'create';
				if ( $match ) {
					$input['id'] = $match['id'];
				}
				if ( $dry_run ) {
					$event_for_check = $input['eventId'] ?? null;
					unset( $input['eventId'] );   // the event may not exist yet; checked above
					QD_Sessions::save_as( $input, $me, true );
					if ( null !== $event_for_check ) {
						$input['eventId'] = $event_for_check;
					}
				} else {
					if ( $has( 'event' ) && $out['event'] && ! isset( $events_by_name[ strtolower( $out['event'] ) ] ) ) {
						$events_by_name[ strtolower( $out['event'] ) ] = self::create_event( $out['event'], $me );
					}
					if ( $has( 'event' ) && $out['event'] ) {
						$input['eventId'] = $events_by_name[ strtolower( $out['event'] ) ]['id'];
					}
					$id                = QD_Sessions::save_as( $input, $me, false );
					$existing[ self::session_key( $input['name'], $input['scheduledStart'] ?? null, $input['scheduledEnd'] ?? null ) ] = QD_Store::get_session( $id );
					if ( ! $match ) {
						$created[] = $id;
					}
				}
				if ( $match ) {
					$result['updated']++;
				} else {
					$result['created']++;
				}
			} catch ( QD_Error $e ) {
				$out['action']   = 'error';
				$out['errors'][] = $e->getMessage();
				$result['failed']++;
			}
			$result['rows'][] = $out;
		}

		if ( ! $dry_run ) {
			QD_Activity::$via = '';
			QD_Activity::log( 'Sessions imported', null, $result['created'] . ' created, ' . $result['updated'] . ' updated, '
				. $result['skipped'] . ' skipped, ' . $result['failed'] . ' with problems' );
			// New sessions go on top one at a time, which would reverse the file: keep its order.
			if ( count( $created ) > 1 ) {
				$rest = array();
				foreach ( QD_Store::all_sessions() as $s ) {
					if ( ! in_array( $s['id'], $created, true ) ) {
						$rest[] = $s['id'];
					}
				}
				QD_Sessions::reorder_ids( array_merge( $created, $rest ) );
			}
			$result['state'] = QD_Admin::state();
		}
		return $result;
	}

	private static function create_event( $name, $me ) {
		$id = QD_Util::new_id( 8 );
		QD_Util::with_lock( 'events', function () use ( $id, $name, $me ) {
			$orders = array();
			foreach ( QD_Store::all_events() as $ev ) {
				$orders[] = (int) ( $ev['order'] ?? 0 );
			}
			QD_Store::save_event( array(
				'id'        => $id,
				'name'      => QD_Util::clean_text( $name, 80 ),
				'brand'     => array(),
				'hasLogo'   => false,
				'created'   => QD_Util::now_ms(),
				'createdBy' => $me,
				'order'     => $orders ? min( $orders ) - 1 : 0,
			) );
		} );
		$event = QD_Store::get_event( $id );
		QD_Activity::log( 'Event created', array( 'id' => $id, 'eventName' => $event['name'] ), '' );
		return $event;
	}
}
