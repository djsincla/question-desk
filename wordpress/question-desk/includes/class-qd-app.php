<?php
/**
 * What the plugin shares with the Apps Script app: the page files, the text catalog (UI_TEXT) and
 * CONFIG, built into pages/ and data/app.json by wordpress/build.js.
 */

defined( 'ABSPATH' ) || exit;

class QD_App {

	/** @var array|null */
	private static $data = null;

	public static function data() {
		if ( null === self::$data ) {
			$json       = file_get_contents( QD_DIR . 'data/app.json' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			self::$data = json_decode( $json, true );
		}
		return self::$data;
	}

	/** A CONFIG value (the same names as in Code.js). */
	public static function config( $key ) {
		$config = self::data()['config'];
		return $config[ $key ] ?? null;
	}

	/** The part of UI_TEXT a page gets as BOOT.text, or null. */
	public static function text_for( $file ) {
		$data = self::data();
		$part = $data['uiTextFor'][ $file ] ?? null;
		return $part ? $data['uiText'][ $part ] : null;
	}

	/** Does this page read BOOT.words? */
	public static function has_words( $file ) {
		return ! empty( self::data()['appTextFor'][ $file ] );
	}

	/**
	 * The whole staff catalog in one language, English wherever that language has no wording yet
	 * (wordsFor_ in server/strings.js).
	 */
	public static function words_for( $lang ) {
		$data = self::data();
		$code = isset( $data['config']['appLanguages'][ $lang ] ) ? $lang : 'en';
		$out  = array();
		foreach ( $data['appText'] as $key => $languages ) {
			$out[ $key ] = $languages[ $code ] ?? $languages['en'];
		}
		return $out;
	}

	/** One phrase, for the server's own use. */
	public static function t( $key, $vars = null, $lang = 'en' ) {
		$data = self::data();
		if ( ! isset( $data['appText'][ $key ] ) ) {
			throw new QD_Error( 'Unknown phrase ' . $key . '.' );
		}
		$code = isset( $data['config']['appLanguages'][ $lang ] ) ? $lang : 'en';
		$text = $data['appText'][ $key ][ $code ] ?? $data['appText'][ $key ]['en'];
		foreach ( (array) $vars as $name => $value ) {
			$text = str_replace( '{' . $name . '}', (string) $value, $text );
		}
		return $text;
	}

	/** The languages the app itself can be read in, for the Admin page's pickers. */
	public static function app_languages() {
		$out = array();
		foreach ( self::data()['config']['appLanguages'] as $code => $names ) {
			$out[] = array( 'code' => $code, 'name' => $names['name'], 'native' => $names['native'] );
		}
		return $out;
	}

	/** t() for a count: the catalog holds key.one and key.other. */
	public static function tn( $key, $n, $vars = null, $lang = 'en' ) {
		$all = is_array( $vars ) ? $vars : array();
		if ( ! isset( $all['n'] ) ) {
			$all['n'] = $n;
		}
		return self::t( $key . '.' . ( 1 === (int) $n ? 'one' : 'other' ), $all, $lang );
	}

	/** An app language code we actually have, or English. */
	public static function app_language_code( $code ) {
		return $code && isset( self::data()['config']['appLanguages'][ $code ] ) ? $code : 'en';
	}

	/** The site's own language: what a room screen and anyone with no choice of their own reads. */
	public static function site_language() {
		return self::app_language_code( get_option( 'qd_app_language', '' ) );
	}

	/** The language one person reads the app in. Set per person on the People tab. */
	public static function app_language( $email = null ) {
		$user = null === $email ? wp_get_current_user() : get_user_by( 'email', $email );
		$own  = $user && $user->ID ? get_user_meta( $user->ID, 'qd_lang', true ) : '';
		return self::app_language_code( $own ?: self::site_language() );
	}

	/**
	 * The language a room screen, slide and panelist view speak. Nobody is signed in at a venue
	 * laptop, so it follows the session, then its event, then the site.
	 */
	public static function room_language( $session ) {
		if ( ! empty( $session['roomLanguage'] ) ) {
			return self::app_language_code( $session['roomLanguage'] );
		}
		$event = ! empty( $session['eventId'] ) ? QD_Store::get_event( $session['eventId'] ) : null;
		if ( ! empty( $event['roomLanguage'] ) ) {
			return self::app_language_code( $event['roomLanguage'] );
		}
		return self::site_language();
	}

	/** Contents of a page file (Ask.html, Styles.html…). */
	public static function page_file( $file ) {
		if ( ! preg_match( '/^[A-Za-z]+\.html$/', $file ) ) {
			throw new QD_Error( QD_App::t( 'wp.err.unknownPage' ) );
		}
		return file_get_contents( QD_DIR . 'pages/' . $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	}
}
