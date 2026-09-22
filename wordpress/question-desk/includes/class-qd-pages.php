<?php
/**
 * Renders the shared page files the way page_() does in the Apps Script version: server data as
 * BOOT, the page's sections of Styles.html and Scripts.html, and the participant-facing text.
 * The pages call the server through google.script.run, which assets/qd-run.js provides here.
 */

defined( 'ABSPATH' ) || exit;

class QD_Pages {

	/** Pages other sites (the guest page, the PowerPoint add-in) may show in a frame. */
	const FRAMABLE = array( 'Ask.html', 'Present.html', 'Panel.html', 'Denied.html' );

	/**
	 * The full HTML for a page.
	 *
	 * @param string     $file    Page file, e.g. 'Home.html'.
	 * @param string     $title   Browser tab title.
	 * @param array      $boot    Server data for the page (BOOT).
	 * @param array|null $session The session the page is about, for its branding.
	 */
	public static function render( $file, $title, array $boot, $session = null ) {
		$html          = QD_App::page_file( $file );
		$boot['brand'] = QD_Brand::for_session( $session );
		$text          = QD_App::text_for( $file );
		if ( $text ) {
			$boot['text'] = $text;
		}
		if ( QD_App::has_words( $file ) ) {
			// Nobody is signed in at a venue laptop, so the room screen and the panelist view read
			// the session's language; every other page reads the person's in front of it.
			$room          = in_array( $file, array( 'Present.html', 'Panel.html' ), true );
			$boot['lang']  = $room ? QD_App::room_language( $session ) : QD_App::app_language();
			$boot['words'] = QD_App::words_for( $boot['lang'] );
		}

		$replacements = array(
			'<?!= boot ?>'    => self::boot_json( $boot ),
			'<?!= styles ?>'  => '<style>' . "\n" . self::sections( 'Styles.html', 'style', $file ) . '</style>',
			'<?!= scripts ?>' => self::scripts_tag( $file ),
		);
		$html = strtr( $html, $replacements );

		// What Apps Script adds around a page: title, viewport, favicon, and here the transport.
		$head  = '<title>' . esc_html( $title ) . '</title>';
		$head .= '<meta name="viewport" content="width=device-width, initial-scale=1">';
		$head .= '<meta name="robots" content="noindex">';
		if ( $boot['brand']['faviconUrl'] ) {
			$head .= '<link rel="icon" href="' . esc_url( $boot['brand']['faviconUrl'] ) . '">';
		}
		$head .= '<script>window.QD_CONFIG = ' . self::boot_json( self::transport_config() ) . ';</script>';
		$head .= '<script src="' . esc_url( QD_URL . 'assets/qd-run.js?v=' . QD_VERSION ) . '"></script>';
		return preg_replace( '/<head>/', '<head>' . $head, $html, 1 );
	}

	/** Sends the page with the headers it needs, then stops WordPress. */
	public static function send( $file, $title, array $boot, $session = null ) {
		$html = self::render( $file, $title, $boot, $session );
		nocache_headers();
		header( 'Content-Type: text/html; charset=utf-8' );
		if ( ! in_array( $file, self::FRAMABLE, true ) ) {
			header( 'X-Frame-Options: SAMEORIGIN' );   // Admin and the queue: never inside another site
		}
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a trusted page file with JSON-escaped data
		exit;
	}

	/** JSON safe inside a <script>: no "<", and U+2028/U+2029 escaped (they end a JS line). */
	public static function boot_json( $value ) {
		$json = wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		return str_replace( array( '<', "\u{2028}", "\u{2029}" ), array( '\\u003c', '\\u2028', '\\u2029' ), $json );
	}

	/** The sections of Styles.html or Scripts.html marked for this page (data-pages="…"), in order. */
	public static function sections( $source, $tag, $file ) {
		$page = preg_replace( '/\.html$/', '', $file );
		$text = QD_App::page_file( $source );
		$out  = '';
		$re   = '/<' . $tag . '\s+data-pages\s*=\s*["\']([A-Za-z ]+)["\']\s*>([\s\S]*?)<\/' . $tag . '>/';
		if ( preg_match_all( $re, $text, $matches, PREG_SET_ORDER ) ) {
			foreach ( $matches as $m ) {
				if ( in_array( $page, preg_split( '/\s+/', trim( $m[1] ) ), true ) ) {
					$out .= preg_replace( '/^\n/', '', $m[2] );
				}
			}
		}
		return $out;
	}

	private static function scripts_tag( $file ) {
		$js = self::sections( 'Scripts.html', 'script', $file );
		return '' === $js ? '' : "<script>\n" . $js . '</script>';
	}

	/** Where qd-run.js sends calls, and the nonce that lets WordPress recognize a signed-in user. */
	public static function transport_config() {
		return array(
			'endpoint' => esc_url_raw( rest_url( 'question-desk/v1/call/' ) ),
			'nonce'    => is_user_logged_in() ? wp_create_nonce( 'wp_rest' ) : '',
		);
	}
}
