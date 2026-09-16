<?php
/**
 * A problem to tell the person using the page, in plain words (the Apps Script version throws
 * Error('…'), which google.script.run hands to the page's failure handler as err.message).
 */

defined( 'ABSPATH' ) || exit;

class QD_Error extends Exception {}
