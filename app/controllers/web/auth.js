const util = require('util');
const moment = require('moment');
const s = require('underscore.string');
const randomstring = require('randomstring-extended');
const Boom = require('boom');
const _ = require('lodash');
const validator = require('validator');
const { select } = require('mongoose-json-select');
const sanitizeHtml = require('sanitize-html');

const { Users, Jobs } = require('../../models');
const { passport } = require('../../../helpers');
const config = require('../../../config');

const sanitize = str =>
  sanitizeHtml(str, {
    allowedTags: [],
    allowedAttributes: []
  });

const logout = async ctx => {
  ctx.logout();
  ctx.flash('custom', {
    title: ctx.req.t('Logged out!'),
    text: ctx.req.t('You have logged out.'),
    type: 'success',
    toast: true,
    showConfirmButton: false,
    timer: 3000,
    position: 'top'
  });
  ctx.redirect(`/${ctx.locale}`);
};

const registerOrLogin = async ctx => {
  // if the user passed `?return_to` and it is not blank
  // then set it as the returnTo value for when we log in
  if (_.isString(ctx.query.return_to) && !s.isBlank(ctx.query.return_to)) {
    ctx.session.returnTo = ctx.query.return_to;
  } else if (_.isString(ctx.query.redirect_to) && !s.isBlank(ctx.query.redirect_to)) {
    // in case people had a typo, we should support redirect_to as well
    ctx.session.returnTo = ctx.query.redirect_to;
  }

  // prevents lad being used as a open redirect
  if (
    ctx.session.returnTo &&
    ctx.session.returnTo.indexOf('://') !== -1 &&
    ctx.session.returnTo.indexOf(config.urls.web) !== 0
  ) {
    ctx.logger.warn(`Prevented abuse with returnTo hijacking to ${ctx.session.returnTo}`);
    ctx.session.returnTo = null;
  }

  ctx.state.verb = ctx.pathWithoutLocale === '/register' ? 'sign up' : 'sign in';

  await ctx.render('register-or-login');
};

const homeOrDashboard = async ctx => {
  // If the user is logged in then take them to their dashboard
  if (ctx.isAuthenticated())
    return ctx.redirect(
      `/${ctx.locale}${config.passportCallbackOptions.successReturnToOrRedirect}`
    );
  // Manually set page title since we don't define Home route in config/meta
  ctx.state.meta = {
    title: sanitize(ctx.req.t(`Home &#124; <span class="notranslate">${config.appName}</span>`)),
    description: sanitize(ctx.req.t(config.pkg.description))
  };
  await ctx.render('home');
};

const login = async (ctx, next) => {
  try {
    await passport.authenticate('local', (err, user, info) => {
      return new Promise(async (resolve, reject) => {
        if (err) return reject(err);

        // redirect user to their last locale they were using
        if (!s.isBlank(user.last_locale) && user.last_locale !== ctx.locale) {
          ctx.state.locale = user.last_locale;
          ctx.req.locale = ctx.state.locale;
          ctx.locale = ctx.req.locale;
        }

        let redirectTo = `/${ctx.locale}${
          config.passportCallbackOptions.successReturnToOrRedirect
        }`;

        if (ctx.session && ctx.session.returnTo) {
          redirectTo = ctx.session.returnTo;
          delete ctx.session.returnTo;
        }

        if (user) {
          try {
            await ctx.login(user);
          } catch (err) {
            return reject(err);
          }

          let text = '';
          if (moment().format('HH') >= 12 && moment().format('HH') <= 17)
            text += ctx.req.t('Good afternoon');
          else if (moment().format('HH') >= 17) text += ctx.req.t('Good evening');
          else text += ctx.req.t('Good morning');
          text += ` ${user.display_name}.`;

          ctx.flash('custom', {
            title: ctx.req.t('Welcome!'),
            text,
            type: 'success',
            toast: true,
            showConfirmButton: false,
            timer: 3000,
            position: 'top'
          });

          if (ctx.accepts('json')) {
            ctx.body = { redirectTo };
          } else {
            ctx.redirect(redirectTo);
          }

          return resolve();
        }

        if (info) return reject(info);

        reject(ctx.translate('UNKNOWN_ERROR'));
      });
    })(ctx, next);
  } catch (err) {
    // passport-local-mongoose error detection
    // so that we can do a proper error status code
    // and also translate the error to the user's locale
    if (err.name && err.message) {
      ctx.throw(Boom.badRequest(ctx.req.t(err.message)));
    } else {
      ctx.throw(err);
    }
  }
};

const register = async ctx => {
  const { body } = ctx.request;

  if (!_.isString(body.email) || !validator.isEmail(body.email))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_EMAIL')));

  if (!_.isString(body.password) || s.isBlank(body.password))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_PASSWORD')));

  // register the user
  try {
    const count = await Users.count({ group: 'admin' });
    const user = await Users.registerAsync(
      { email: body.email, group: count === 0 ? 'admin' : 'user' },
      body.password
    );

    await ctx.login(user);

    let redirectTo = `/${ctx.locale}${config.passportCallbackOptions.successReturnToOrRedirect}`;

    if (ctx.session && ctx.session.returnTo) {
      redirectTo = ctx.session.returnTo;
      delete ctx.session.returnTo;
    }

    ctx.flash('custom', {
      title: ctx.req.t('Thanks!'),
      text: ctx.translate('REGISTERED'),
      type: 'success',
      toast: true,
      showConfirmButton: false,
      timer: 3000,
      position: 'top'
    });

    if (ctx.accepts('json')) {
      ctx.body = { redirectTo };
    } else {
      ctx.redirect(redirectTo);
    }

    // add welcome email job
    try {
      const job = await Jobs.create({
        name: 'email',
        data: {
          template: 'welcome',
          to: user.email,
          locals: {
            user: select(user.toObject(), Users.schema.options.toJSON.select)
          }
        }
      });
      ctx.logger.debug('queued welcome email', job);
    } catch (err) {
      ctx.logger.error(err);
    }
  } catch (err) {
    ctx.throw(Boom.badRequest(err.message));
  }
};

const forgotPassword = async ctx => {
  const { body } = ctx.request;

  if (!_.isString(body.email) || !validator.isEmail(body.email))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_EMAIL')));

  // lookup the user
  const user = await Users.findOne({ email: body.email });

  // to prevent people from being able to find out valid email accounts
  // we always say "a password reset request has been sent to your email"
  // and if the email didn't exist in our system then we simply don't send it
  if (!user) {
    if (ctx.accepts('json')) {
      ctx.body = {
        message: ctx.translate('PASSWORD_RESET_SENT')
      };
    } else {
      ctx.flash('success', ctx.translate('PASSWORD_RESET_SENT'));
      ctx.redirect('back');
    }
    return;
  }

  // if we've already sent a reset password request in the past half hour
  if (
    user.reset_token_expires_at &&
    user.reset_token &&
    moment(user.reset_token_expires_at).isBefore(moment().add(30, 'minutes'))
  )
    return ctx.throw(
      Boom.badRequest(
        ctx.translate('PASSWORD_RESET_LIMIT', moment(user.reset_token_expires_at).fromNow())
      )
    );

  // set the reset token and expiry
  user.reset_token_expires_at = moment()
    .add(30, 'minutes')
    .toDate();
  user.reset_token = randomstring.token();

  await user.save();

  if (ctx.accepts('json')) {
    ctx.body = {
      message: ctx.translate('PASSWORD_RESET_SENT')
    };
  } else {
    ctx.flash('success', ctx.translate('PASSWORD_RESET_SENT'));
    ctx.redirect('back');
  }

  // queue password reset email
  try {
    const job = await Jobs.create({
      name: 'email',
      data: {
        template: 'reset-password',
        to: user.email,
        locals: {
          user: _.pick(user, ['display_name', 'reset_token_expires_at']),
          link: `${config.urls.web}/reset-password/${user.reset_token}`
        }
      }
    });
    ctx.logger.debug('Queued reset password email', job);
  } catch (err) {
    ctx.logger.error(err);
  }
};

const resetPassword = async ctx => {
  const { body } = ctx.request;

  if (!_.isString(body.email) || !validator.isEmail(body.email))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_EMAIL')));

  if (!_.isString(body.password) || s.isBlank(body.password))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_PASSWORD')));

  if (!_.isString(ctx.params.token) || s.isBlank(ctx.params.token))
    return ctx.throw(Boom.badRequest(ctx.translate('INVALID_RESET_TOKEN')));

  // lookup the user that has this token and if it matches the email passed
  const user = await Users.findOne({
    email: body.email,
    reset_token: ctx.params.token,
    // ensure that the reset_at is only valid for 30 minutes
    reset_token_expires_at: {
      $gte: new Date()
    }
  });

  if (!user) {
    ctx.throw(Boom.badRequest(ctx.translate('INVALID_RESET_PASSWORD')));
  }

  user.reset_token = null;
  user.reset_at = null;

  try {
    await util.promisify(user.setPassword).bind(user)(body.password);
  } catch (err) {
    ctx.throw(Boom.badRequest(ctx.translate('INVALID_PASSWORD_STRENGTH')));
  } finally {
    await user.save();
    await util.promisify(ctx.login).bind(ctx.req)(user);
    if (ctx.accepts('json')) {
      ctx.body = {
        message: ctx.translate('RESET_PASSWORD'),
        redirectTo: `/${ctx.locale}`
      };
    } else {
      ctx.flash('success', ctx.translate('RESET_PASSWORD'));
      ctx.redirect(`/${ctx.locale}`);
    }
  }
};

module.exports = {
  logout,
  registerOrLogin,
  homeOrDashboard,
  login,
  register,
  forgotPassword,
  resetPassword
};
