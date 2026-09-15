<?php
/**
 * Site settings: branding, logos (Media Library), languages and the summary recipients
 * (admin.js and parts of participants.js in the Apps Script version).
 */

defined( 'ABSPATH' ) || exit;

class QD_Settings {

	public static function save_brand( $input ) {
		QD_People::require_admin();
		$input = (array) $input;
		$color = function ( $value, $fallback ) {
			return preg_match( QD_Util::HEX_RE, (string) $value ) ? strtolower( (string) $value ) : $fallback;
		};
		$favicon = trim( (string) ( $input['faviconUrl'] ?? '' ) );
		if ( $favicon && ! preg_match( '#^https://[^\s"\'<>]+$#', $favicon ) ) {
			throw new QD_Error( 'The tab icon must be an https:// link to an image.' );
		}
		$brand = get_option( 'qd_brand', array() );
		$brand = is_array( $brand ) ? $brand : array();
		$saved = array(
			'orgName'     => QD_Util::clean_text( $input['orgName'] ?? '', 80 ),
			'accent'      => $color( $input['accent'] ?? '', QD_Brand::DEFAULT_ACCENT ),
			'welcome'     => QD_Util::clean_text( $input['welcome'] ?? '', 200 ),
			'footer'      => QD_Util::clean_text( $input['footer'] ?? '', 160 ),
			'roomBgDark'  => $color( $input['roomBgDark'] ?? '', '#10171f' ),
			'roomBgLight' => $color( $input['roomBgLight'] ?? '', '#ffffff' ),
			'faviconUrl'  => mb_substr( $favicon, 0, 500 ),
			'logoId'      => (int) ( $brand['logoId'] ?? 0 ),
		);
		update_option( 'qd_brand', $saved );
		QD_Activity::log( 'Branding saved', null, '' );
		return QD_Admin::state();
	}

	public static function save_site_languages( $codes ) {
		QD_People::require_admin();
		$clean = self::clean_languages( $codes );
		update_option( 'qd_languages', $clean );
		QD_Activity::log( 'Site languages changed', null, implode( ', ', array_map( array( __CLASS__, 'language_name' ), $clean ) ) );
		return QD_Admin::state();
	}

	/** Known, unique, English first, at most CONFIG.maxLanguages (cleanLanguages_). */
	public static function clean_languages( $input ) {
		$list      = is_array( $input ) ? $input : preg_split( '/[\s,;]+/', (string) $input );
		$languages = QD_App::config( 'languages' );
		$out       = array( 'en' );
		foreach ( $list as $raw ) {
			$code = strtolower( trim( (string) $raw ) );
			if ( '' === $code ) {
				continue;
			}
			if ( ! isset( $languages[ $code ] ) ) {
				throw new QD_Error( 'Unknown language: ' . $code . '. Choose from ' . implode( ', ', array_keys( $languages ) ) . '.' );
			}
			if ( ! in_array( $code, $out, true ) ) {
				$out[] = $code;
			}
		}
		$max = (int) QD_App::config( 'maxLanguages' );
		if ( count( $out ) > $max ) {
			throw new QD_Error( 'Choose at most ' . $max . ' languages, including English, so the room screen stays readable.' );
		}
		return $out;
	}

	public static function site_languages() {
		$saved = get_option( 'qd_languages', array() );
		return is_array( $saved ) && $saved ? array_values( $saved ) : array_values( (array) QD_App::config( 'defaultLanguages' ) );
	}

	/** A session's languages: its event's choice, or the site default (languagesFor_). */
	public static function languages_for( $session ) {
		$ev = $session && ! empty( $session['eventId'] ) ? QD_Store::get_event( $session['eventId'] ) : null;
		if ( $ev && ! empty( $ev['languages'] ) ) {
			return array_values( (array) $ev['languages'] );
		}
		return self::site_languages();
	}

	public static function language_name( $code ) {
		$languages = QD_App::config( 'languages' );
		return $languages[ $code ]['name'] ?? $code;
	}

	/** [{ code, name, native }] for a page's language buttons (languageList_). */
	public static function language_list( $session ) {
		$languages = QD_App::config( 'languages' );
		return array_values( array_map( function ( $code ) use ( $languages ) {
			return array( 'code' => $code, 'name' => $languages[ $code ]['name'], 'native' => $languages[ $code ]['native'] );
		}, self::languages_for( $session ) ) );
	}

	// ------------------------------------------------------------ summary recipients

	public static function summary_defaults() {
		$saved = get_option( 'qd_summary_defaults', array() );
		return array( 'facilitators' => false, 'extra' => array_values( (array) ( $saved['extra'] ?? array() ) ) );
	}

	public static function save_summary_defaults( $input ) {
		QD_People::require_admin();
		$extra = QD_Util::parse_emails( ( (array) $input )['extra'] ?? array() );
		update_option( 'qd_summary_defaults', array( 'facilitators' => false, 'extra' => $extra ) );
		QD_Activity::log( 'Summary recipients changed', null, $extra ? implode( ', ', $extra ) : 'nobody' );
		return QD_Admin::state();
	}

	/** Who gets a session's summary: the People tab list, and only that (summaryRecipients_). */
	public static function summary_recipients( $session = null ) {
		$max = (int) QD_App::config( 'maxRecipients' );
		return array_slice( self::summary_defaults()['extra'], 0, $max );
	}

	// ------------------------------------------------------------ logos

	/**
	 * Logos are Media Library attachments. The page sends the same downscaled data URL the
	 * Apps Script version stores in the Assets sheet; here it becomes an uploaded file.
	 * $target: '' (site), 'event:<id>' or a session id.
	 */
	public static function save_logo( $data_url, $target = '' ) {
		QD_People::require_admin();
		if ( ! preg_match( '#^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$#', (string) $data_url, $m ) ) {
			throw new QD_Error( 'The logo must be a PNG, JPEG or WebP image.' );
		}
		if ( strlen( $data_url ) > (int) QD_App::config( 'logoMaxChars' ) ) {
			throw new QD_Error( 'That logo is too large even after resizing.' );
		}
		$bytes = base64_decode( $m[2], true );
		if ( false === $bytes ) {
			throw new QD_Error( 'The logo must be a PNG, JPEG or WebP image.' );
		}
		$name   = 'question-desk-logo-' . ( $target ? preg_replace( '/[^a-z0-9]+/i', '-', $target ) : 'site' ) . '-' . time() . '.' . ( 'jpeg' === $m[1] ? 'jpg' : $m[1] );
		$upload = wp_upload_bits( $name, null, $bytes );
		if ( ! empty( $upload['error'] ) ) {
			throw new QD_Error( 'The logo could not be saved: ' . $upload['error'] );
		}
		$id = wp_insert_attachment(
			array( 'post_mime_type' => 'image/' . $m[1], 'post_title' => 'Question Desk logo', 'post_status' => 'inherit' ),
			$upload['file']
		);
		if ( is_wp_error( $id ) || ! $id ) {
			throw new QD_Error( 'The logo could not be saved.' );
		}
		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $upload['file'] ) );
		self::set_logo_id( $target, (int) $id );
		return QD_Admin::state();
	}

	public static function remove_logo( $target = '' ) {
		QD_People::require_admin();
		self::set_logo_id( $target, 0 );
		return QD_Admin::state();
	}

	/** The attachment id for a logo target, or 0. */
	public static function logo_id( $target ) {
		if ( '' === $target ) {
			$brand = (array) get_option( 'qd_brand', array() );
			return (int) ( $brand['logoId'] ?? 0 );
		}
		if ( 0 === strpos( $target, 'event:' ) ) {
			$ev = QD_Store::get_event( substr( $target, 6 ) );
			return (int) ( $ev['logoId'] ?? 0 );
		}
		$session = QD_Store::get_session( $target );
		return (int) ( $session['logoId'] ?? 0 );
	}

	public static function logo_url( $target ) {
		$id = self::logo_id( $target );
		return $id ? (string) wp_get_attachment_image_url( $id, 'medium' ) : '';
	}

	/** Removes a logo without building the whole admin state (used while deleting things). */
	public static function clear_logo( $target ) {
		if ( self::logo_id( $target ) ) {
			self::set_logo_id( $target, 0 );
		}
	}

	private static function set_logo_id( $target, $id ) {
		$old = self::logo_id( $target );
		if ( '' === $target ) {
			$brand           = (array) get_option( 'qd_brand', array() );
			$brand['logoId'] = $id;
			update_option( 'qd_brand', $brand );
			QD_Activity::log( $id ? 'Site logo changed' : 'Site logo removed', null, '' );
		} elseif ( 0 === strpos( $target, 'event:' ) ) {
			$eid = substr( $target, 6 );
			$ev  = QD_Store::get_event( $eid );
			if ( ! $ev ) {
				throw new QD_Error( 'Event not found.' );
			}
			$ev['logoId']  = $id;
			$ev['hasLogo'] = (bool) $id;
			QD_Store::save_event( $ev );
			QD_Activity::log( $id ? 'Event logo changed' : 'Event logo removed', array( 'id' => $eid, 'eventName' => $ev['name'] ), '' );
		} else {
			if ( ! QD_Store::get_session( $target ) ) {
				throw new QD_Error( 'Session not found.' );
			}
			$session = QD_Store::update_session( $target, function ( &$s ) use ( $id ) {
				$s['logoId']  = $id;
				$s['hasLogo'] = (bool) $id;
			} );
			QD_Activity::log( $id ? 'Session logo changed' : 'Session logo removed', $session, '' );
		}
		if ( $old && $old !== $id ) {
			wp_delete_attachment( $old, true );   // the replaced logo leaves no file behind
		}
	}
}
