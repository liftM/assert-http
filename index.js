/* jshint evil: true */
var _ = require('underscore');
var fs = require('fs');
var http = require('http');
var path = require('path');
var util = require('util');
var crypto = require('crypto');
var assert = require('assert');
var request = require('request');
var gm = require('gm');
var mkdirp = require('mkdirp');
require('./assert');

var updateFixtures = false;
module.exports.updateFixtures = function() {
    updateFixtures = true;
};

// Return an object with sorted keys.
function sortKeys(obj) {
    try {
        return obj.map(sortKeys);
    } catch(e) {}
    try {
        return Object.keys(obj).sort().reduce(function(memo, key) {
            memo[key] = sortKeys(obj[key]);
            return memo;
        }, {});
    } catch(e) { return obj; }
}

module.exports.mkdirpSync = mkdirpSync;
function mkdirpSync(p, mode) {
    var ps = path.normalize(p).split('/');
    var created = [];
    while (ps.length) {
        created.push(ps.shift());
        if (created.length > 1 && !fs.existsSync(created.join('/'))) {
            var err = fs.mkdirSync(created.join('/'), 0755);
            if (err) return err;
        }
    }
}

module.exports.md5 = md5;
function md5(data) {
    return crypto.createHash('md5').update(data).digest('hex');
}

function dirty(fixture, handlers, callback) {
    var pattern = /$^/;
    if (handlers) {
        pattern = new RegExp('{(' + Object.keys(handlers).join('|') + ')_?([^}]+)?}');
    }

    var req = JSON.stringify(fixture.request);
    var res = _(fixture.response).clone();
    var next = function(err) {
        if (err) return callback(err);

        // Work through each handler and replace tokens.
        var matches = req.match(pattern);
        if (matches) {
            return handlers[matches[1]](fixture.request, matches[2], function(err, value) {
                if (err) return callback(err);
                var token = [];
                if (matches[1]) token.push(matches[1]);
                if (matches[2]) token.push(matches[2]);
                req = req.replace('{' + token.join('_') + '}', value||'');
                next();
            });
        }

        // All tokens have been replaced.
        req = JSON.parse(req);

        // Stringify body of JSON requests.
        if (req.headers && /json/.test(req.headers['content-type'])) {
            req.body = JSON.stringify(req.body);
        }
        return callback(null, req, res);
    };
    next();
}

module.exports.load = function(dirname) {
    return fs.readdirSync(dirname).sort().filter(function(basename) {
        if (basename[0] == '.') return false;
        return !(/\.(js|json|jsonp|txt|png|jpg|pbf|css|swp|html|kml)$/.test(basename));
    }).map(function(basename) {
        var filepath = dirname + '/' + basename, fixture;
        try {
            fixture = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        } catch (e) {
            console.log(e);
            console.log(filepath);
        }
        var status = fixture.response.statusCode;
        var method = fixture.request.method.substr(0,3);
        return {
            id: basename,
            name: util.format('%s %s - %s', status, method, basename),
            filepath: filepath,
            fixture: fixture
        };
    });
};

module.exports.runtest = function(test, opts, callback) {
    var clean = function(k, v) {
        if (opts.clean && opts.clean[k]) return opts.clean[k](k, v, this);
        return v;
    };
    var fixture = test.fixture || JSON.parse(fs.readFileSync(test.filepath, 'utf8'));

    dirty(fixture, opts.handlers, function(err, req, res) {
        if (err) return callback(err);

        // Body comparison done outside of assert.response.
        delete res.body;

        // If should be safe to assume a headers object
        res.headers = res.headers || {};

        // @TODO temporary default user-agent header override.
        // move this out of runtest and into each test fixture.
        req.headers = req.headers || {};
        req.headers['user-agent'] = req.headers['user-agent'] || 'testagent';

        // Attach clean helper to res object.
        // @TODO this is a hack that assert.response interprets specifically for us.
        res.clean = clean;

        assert.response(req, res, function(err, response) {
            var extname = '';
            if (/text\/plain/.test(response.headers['content-type'])) {
                extname = '.txt';
            } else if (/text\/html/.test(response.headers['content-type'])) {
                extname = '.html';
            } else if (/text\/css/.test(response.headers['content-type'])) {
                extname = '.css';
            // @TODO... check whether it is ok to serve jsonp with content-type
            // 'application/json' ... my guess is not.
            } else if (/json/.test(response.headers['content-type']) && /jsonp|callback=/.test(req.path)) {
                extname = '.jsonp';
            } else if (/json/.test(response.headers['content-type'])) {
                extname = '.json';
            } else if (/text\/javascript/.test(response.headers['content-type'])) {
                extname = '.js';
            } else if (/png/.test(response.headers['content-type'])) {
                extname = '.png';
            } else if (/jpeg/.test(response.headers['content-type'])) {
                extname = '.jpg';
            } else if (/protobuf/.test(response.headers['content-type'])) {
                extname = '.pbf';
            } else if (/kml/.test(response.headers['content-type'])) {
                extname = '.kml';
            }

            // For status code differences, throw -- it's up to the developer
            // to update the expected status code, test again, and let the
            // fixture get updated. Body differences are handled below.
            if (err) {
                if (/Invalid response header/.test(err.message) && updateFixtures) {
                    return needsupdate();
                } else {
                    return callback(err);
                }
            }

            var actualHeaders = Object.keys(response.headers);
            actualHeaders.sort();
            var expectedHeaders = Object.keys(res.headers);
            expectedHeaders.sort();
            if (actualHeaders.toString() != expectedHeaders.toString()) {
                if (updateFixtures) return needsupdate();
                assert.fail(actualHeaders.toString(), expectedHeaders.toString(), 'Missing headers', '=');
            }

            // Load body from separate file if necessary.
            var expected;
            try {
                expected = fixture.response.body || fs.readFileSync(test.filepath + (extname || '.body'), 'utf8');
            } catch(e) {
                if (e.code !== 'ENOENT') throw e;
            }

            if (response.body && !expected) {
                var e = new Error('Unexpected response body');
                if (updateFixtures) {
                    console.error(e);
                    return needsupdate();
                } else {
                    return callback(e);
                }
            }

            if (expected) try {
                switch (extname) {
                case '.txt':
                case '.html':
                case '.kml':
                    assert.equal(clean.call({}, 'body', response.body), expected);
                    break;
                case '.json':
                    assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(response.body), clean)), expected);
                    break;
                case '.jsonp':
                    var cbA = expected.toString().match(/^[a-z]+/)[0];
                    var cbB = response.body.match(/^[a-z]+/)[0];
                    assert.deepEqual(
                        eval('function '+cbB+'(d) { return d; }; ' + response.body),
                        eval('function '+cbA+'(d) { return d; }; ' + expected));
                    break;
                case '.js':
                case '.css':
                    assert.equal(response.body, expected);
                    break;
                case '.pbf':
                    assert.deepEqual(new Buffer(response.body, 'binary'), fs.readFileSync(test.filepath + extname));
                    break;
                case '.png':
                case '.jpg':
                    return imageEqualsFile(new Buffer(response.body, 'binary'), test.filepath + extname, function(err) {
                        if (err && updateFixtures) {
                            console.error(err);
                            return needsupdate();
                        }
                        callback(err, req, response);
                    });
                    break;
                }
            } catch(e) {
                if (updateFixtures) {
                    console.error(e);
                    return needsupdate();
                } else {
                    return callback(e);
                }
            }

            function needsupdate() {
                console.warn('\n');
                console.warn('  *** Updating fixtures (mismatch at %s)', path.basename(test.filepath));
                console.warn('');

                fixture.response.statusCode = response.statusCode;
                fixture.response.headers = response.headers;
                switch (extname) {
                case '.txt':
                    fixture.response.body = response.body;
                    break;
                case '.json':
                    fixture.response.body = JSON.parse(response.body);
                    break;
                case '.jsonp':
                    var matches = response.body.match(/^([\w]+)\((.*)\);$/);
                    var data = matches[1] + '(' + JSON.stringify(sortKeys(JSON.parse(matches[2])), clean, 2) + ');';
                    fs.writeFileSync(test.filepath + extname, data, 'utf8');
                    delete fixture.response.body;
                    break;
                case '.js':
                case '.css':
                case '.html':
                    fs.writeFileSync(test.filepath + extname, response.body, 'utf8');
                    delete fixture.response.body;
                    break;
                case '.png':
                case '.jpg':
                case '.pbf':
                    fs.writeFileSync(test.filepath + extname, response.body, 'binary');
                    delete fixture.response.body;
                    break;
                default:
                    fixture.response.body = response.body;
                    break;
                }
                fs.writeFileSync(test.filepath, JSON.stringify(sortKeys(fixture), clean, 2) + '\n');

                callback(err, req, response);
            }

            return callback(err, req, response);
        });
    });
};

// Image comparison.
function imageEqualsFile(buffer, fixture, callback) {
    var fixturesize = fs.statSync(fixture).size;
    var sizediff = Math.abs(fixturesize - buffer.length) / fixturesize;
    if (sizediff > 0.10) {
        return callback(new Error('Image size is too different from fixture: ' + buffer.length + ' vs. ' + fixturesize));
    }
    var dir = '/tmp/tilestream-pro-compare';
    var actual = path.join(dir, md5(buffer));
    mkdirp(dir, function(err) {
        if (err) return callback(err);
        fs.writeFile(actual, buffer, function(err) {
            if (err) return callback(err);
            var tolerance = 0.008;
            gm.compare(fixture, actual, tolerance, function(err, isEqual, equality, raw) {
                if (err) return callback(err);
                if (!isEqual) {
                    return callback(new Error('Image is too different from fixture: ' + equality + ' > ' + tolerance));
                }
                callback();
            });
        });
    });
}
