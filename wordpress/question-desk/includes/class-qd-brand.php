<?php
/**
 * Branding, resolved site → event → session, each level overriding only what it sets (brand_()).
 * Logos are Media Library attachments, so pages get a URL where the Apps Script version gives a
 * data URL; both work as an image source.
 */

defined( 'ABSPATH' ) || exit;

class QD_Brand {

	const DEFAULT_ACCENT = '#1b5e5a';

	public static function site() {
		$base = get_option( 'qd_brand', array() );
		$base = is_array( $base ) ? $base : array();
		return array(
			'orgName'     => (string) ( $base['orgName'] ?? get_bloginfo( 'name' ) ),
			'accent'      => (string) ( $base['accent'] ?? self::DEFAULT_ACCENT ),
			'welcome'     => (string) ( $base['welcome'] ?? '' ),
			'footer'      => (string) ( $base['footer'] ?? '' ),
			'roomBgDark'  => (string) ( $base['roomBgDark'] ?? '#10171f' ),
			'roomBgLight' => (string) ( $base['roomBgLight'] ?? '#ffffff' ),
			'faviconUrl'  => (string) ( $base['faviconUrl'] ?? get_site_icon_url() ),
			'logo'        => QD_Settings::logo_url( '' ),
		);
	}

	/** @param array|null $session */
	public static function for_session( $session ) {
		$brand = self::site();
		$ev    = $session && ! empty( $session['eventId'] ) ? QD_Store::get_event( $session['eventId'] ) : null;
		if ( $ev ) {
			foreach ( array( 'orgName', 'accent', 'welcome', 'footer', 'roomBgDark', 'roomBgLight' ) as $key ) {
				if ( ! empty( $ev['brand'][ $key ] ) ) {
					$brand[ $key ] = $ev['brand'][ $key ];
				}
			}
			$logo = QD_Settings::logo_url( 'event:' . $ev['id'] );
			if ( $logo ) {
				$brand['logo'] = $logo;
			}
			$brand['eventName'] = (string) $ev['name'];
		}
		if ( $session ) {
			if ( ! empty( $session['brand']['orgName'] ) ) {
				$brand['orgName'] = $session['brand']['orgName'];
			}
			if ( ! empty( $session['brand']['accent'] ) ) {
				$brand['accent'] = $session['brand']['accent'];
			}
			$logo = QD_Settings::logo_url( (string) $session['id'] );
			if ( $logo ) {
				$brand['logo'] = $logo;
			}
		}
		return $brand;
	}
}
