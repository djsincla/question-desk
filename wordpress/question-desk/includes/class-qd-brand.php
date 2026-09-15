<?php
/**
 * Branding, resolved site → event → session like brand_() in the Apps Script version. Phase 0
 * reads the site level; events and sessions are added with them.
 */

defined( 'ABSPATH' ) || exit;

class QD_Brand {

	const DEFAULT_ACCENT = '#1b5e5a';

	public static function site() {
		$base = get_option( 'qd_brand', array() );
		$base = is_array( $base ) ? $base : array();
		$logo = ! empty( $base['logoId'] ) ? wp_get_attachment_image_url( (int) $base['logoId'], 'medium' ) : '';
		return array(
			'orgName'     => (string) ( $base['orgName'] ?? get_bloginfo( 'name' ) ),
			'accent'      => (string) ( $base['accent'] ?? self::DEFAULT_ACCENT ),
			'welcome'     => (string) ( $base['welcome'] ?? '' ),
			'footer'      => (string) ( $base['footer'] ?? '' ),
			'roomBgDark'  => (string) ( $base['roomBgDark'] ?? '#10171f' ),
			'roomBgLight' => (string) ( $base['roomBgLight'] ?? '#ffffff' ),
			'faviconUrl'  => (string) ( $base['faviconUrl'] ?? get_site_icon_url() ),
			'logo'        => $logo ? $logo : '',
		);
	}

	/** @param array|null $session */
	public static function for_session( $session ) {
		return self::site();
	}
}
