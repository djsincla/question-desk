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

	/** Contents of a page file (Ask.html, Styles.html…). */
	public static function page_file( $file ) {
		if ( ! preg_match( '/^[A-Za-z]+\.html$/', $file ) ) {
			throw new QD_Error( 'Unknown page.' );
		}
		return file_get_contents( QD_DIR . 'pages/' . $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	}
}
