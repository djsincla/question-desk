<?php
/**
 * PHPUnit bootstrap: WordPress's test library with the plugin loaded and activated.
 * Run inside wp-env:  npm run wp:test
 */

$tests_dir = getenv( 'WP_TESTS_DIR' ) ?: '/wordpress-phpunit';
if ( ! file_exists( $tests_dir . '/includes/functions.php' ) ) {
	fwrite( STDERR, "WordPress test library not found in $tests_dir. Run the tests inside wp-env.\n" ); // phpcs:ignore
	exit( 1 );
}
// PHPUnit Polyfills, which WordPress's test library needs (composer install, dev only).
$autoload = dirname( __DIR__ ) . '/vendor/autoload.php';
if ( ! file_exists( $autoload ) ) {
	fwrite( STDERR, "Run composer install in the plugin folder first (npm run wp:test does).\n" ); // phpcs:ignore
	exit( 1 );
}
require_once $autoload;

require_once $tests_dir . '/includes/functions.php';

tests_add_filter(
	'muplugins_loaded',
	function () {
		require dirname( __DIR__ ) . '/question-desk.php';
	}
);
tests_add_filter( 'init', array( 'QD_Install', 'activate' ), 0 );

require $tests_dir . '/includes/bootstrap.php';
