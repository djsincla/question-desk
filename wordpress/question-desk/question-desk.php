<?php
/**
 * Plugin Name:       Question Desk
 * Plugin URI:        https://github.com/djsincla/question-desk
 * Description:       Anonymous, multilingual audience questions for live events: phones ask, facilitators see them grouped and translated by Gemini, and the room sees what's being answered.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            Question Desk contributors
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       question-desk
 */

defined( 'ABSPATH' ) || exit;

define( 'QD_VERSION', '0.1.0' );
define( 'QD_FILE', __FILE__ );
define( 'QD_DIR', plugin_dir_path( __FILE__ ) );
define( 'QD_URL', plugin_dir_url( __FILE__ ) );

require_once QD_DIR . 'includes/class-qd-error.php';
require_once QD_DIR . 'includes/class-qd-app.php';
require_once QD_DIR . 'includes/class-qd-install.php';
require_once QD_DIR . 'includes/class-qd-util.php';
require_once QD_DIR . 'includes/class-qd-cache.php';
require_once QD_DIR . 'includes/class-qd-store.php';
require_once QD_DIR . 'includes/class-qd-people.php';
require_once QD_DIR . 'includes/class-qd-activity.php';
require_once QD_DIR . 'includes/class-qd-settings.php';
require_once QD_DIR . 'includes/class-qd-questions.php';
require_once QD_DIR . 'includes/class-qd-topics.php';
require_once QD_DIR . 'includes/class-qd-tokens.php';
require_once QD_DIR . 'includes/class-qd-screen.php';
require_once QD_DIR . 'includes/class-qd-events.php';
require_once QD_DIR . 'includes/class-qd-sessions.php';
require_once QD_DIR . 'includes/class-qd-admin.php';
require_once QD_DIR . 'includes/class-qd-brand.php';
require_once QD_DIR . 'includes/class-qd-pages.php';
require_once QD_DIR . 'includes/class-qd-router.php';
require_once QD_DIR . 'includes/class-qd-api.php';
require_once QD_DIR . 'includes/class-qd-participants.php';

register_activation_hook( __FILE__, array( 'QD_Install', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'QD_Install', 'deactivate' ) );

add_action( 'plugins_loaded', array( 'QD_Install', 'maybe_upgrade' ) );
QD_Router::init();
QD_Api::init();
QD_Admin::init();
QD_Participants::init();
QD_Screen::init();
