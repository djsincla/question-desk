<?php
/** Small helpers shared by the server code (plumbing.js in the Apps Script version). */

defined( 'ABSPATH' ) || exit;

class QD_Util {

	const ID_RE    = '/^[a-f0-9]{8}$/';
	const HEX_RE   = '/^#[0-9a-f]{6}$/i';
	const EMAIL_RE = '/^[^@\s,;<>"\']+@[^@\s,;<>"\']+\.[^@\s,;<>"\']+$/';

	/** Random lowercase hex, like newId_(). */
	public static function new_id( $length ) {
		return substr( bin2hex( random_bytes( (int) ceil( $length / 2 ) + 1 ) ), 0, $length );
	}

	/** Collapses whitespace, trims and cuts to $max characters, like cleanText_(). */
	public static function clean_text( $value, $max ) {
		$text = trim( preg_replace( '/\s+/u', ' ', (string) ( $value ?? '' ) ) );
		return mb_substr( $text, 0, $max );
	}

	/** Emails from a list or a comma/space separated string: lowercased, checked, de-duplicated. */
	public static function parse_emails( $input ) {
		$list = is_array( $input ) ? $input : preg_split( '/[\s,;]+/', (string) $input );
		$out  = array();
		foreach ( $list as $raw ) {
			$email = strtolower( trim( (string) $raw ) );
			if ( '' === $email ) {
				continue;
			}
			if ( ! preg_match( self::EMAIL_RE, $email ) ) {
				throw new QD_Error( QD_App::t( 'err.notAnEmail', array( 'value' => $email ) ) );
			}
			if ( ! in_array( $email, $out, true ) ) {
				$out[] = $email;
			}
		}
		$max = (int) QD_App::config( 'maxRecipients' );
		if ( count( $out ) > $max ) {
			throw new QD_Error( QD_App::t( 'err.tooManyRecipients', array( 'max' => $max ) ) );
		}
		return $out;
	}

	/** Destructive actions need the name typed back (case and spacing forgiven). */
	public static function require_typed_name( array $item, $typed, $what = 'session' ) {
		$norm = function ( $v ) {
			return strtolower( trim( preg_replace( '/\s+/u', ' ', (string) $v ) ) );
		};
		if ( '' === $norm( $typed ) || $norm( $typed ) !== $norm( $item['name'] ?? '' ) ) {
			throw new QD_Error( QD_App::t( 'err.typeTheNameToConfirm', array( 'what' => $what, 'name' => $item['name'] ?? '' ) ) );
		}
	}

	/** Milliseconds since the epoch, as the pages and the Apps Script version use. */
	public static function now_ms() {
		return (int) round( microtime( true ) * 1000 );
	}

	/**
	 * Runs $fn holding a MySQL named lock (LockService in the Apps Script version). Named locks
	 * don't commit transactions, so they're safe inside WordPress's test transactions too.
	 */
	public static function with_lock( $name, callable $fn ) {
		global $wpdb;
		$lock = 'qd_' . substr( md5( $wpdb->prefix . $name ), 0, 32 );
		$got  = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 10)', $lock ) );
		if ( 1 !== $got ) {
			throw new QD_Error( QD_App::t( 'wp.err.busy' ) );
		}
		try {
			return $fn();
		} finally {
			$wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) );
		}
	}

	/** A JSON column's value as an array ({} and bad JSON become []). */
	public static function json_array( $value ) {
		$decoded = is_string( $value ) && '' !== $value ? json_decode( $value, true ) : null;
		return is_array( $decoded ) ? $decoded : array();
	}
}
