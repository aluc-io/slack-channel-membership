'use strict'

import qs from 'querystring'
import axios from 'axios'
import AWS from 'aws-sdk'
import { Context, APIGatewayEvent } from 'aws-lambda'
import { intersection, difference, compact } from 'lodash'
import to from 'await-to-js'
import { SlashCommandPayload } from 'seratch-slack-types/app-backend/slash-commands'
import { ViewSubmissionPayload } from 'seratch-slack-types/app-backend/views'
import { ConversationsMembersResponse, UsersListResponse } from 'seratch-slack-types/web-api'
import { WebClient, ViewsOpenArguments, ChatPostEphemeralArguments, SectionBlock } from '@slack/web-api'
import { Member } from 'seratch-slack-types/web-api/UsersListResponse'

const TableName = process.env.SCM_DYNAMODB_TABLE_NAME || ''
const httpOptions: AWS.HTTPOptions = { timeout: 2000 }
const ddc = new AWS.DynamoDB.DocumentClient({ httpOptions })
const COMMA_SEPARATED_EMAILS = 'COMMA_SEPARATED_EMAILS'
const MODAL_MAIN = 'MODAL_MAIN'

interface IModalMainPM {
  channelId: string
}

const modal = (trigger_id: string, channelId: string): ViewsOpenArguments => {
  const privateMetadata: IModalMainPM = { channelId }

  return {
    trigger_id,
    view: {
      private_metadata: JSON.stringify(privateMetadata),
      callback_id: MODAL_MAIN,
      type: "modal",
      title: { "type": "plain_text", "text": "채널 멤버 관리", "emoji": true },
      submit: { "type": "plain_text", "text": "Save", "emoji": true },
      close: { "type": "plain_text", "text": "Cancel", "emoji": true },
      blocks: [
        {
          "type": "input",
          block_id: COMMA_SEPARATED_EMAILS,
          "element": {
            "type": "plain_text_input",
            "action_id": "emails",
            "multiline": true,
            "placeholder": {
              "type": "plain_text",
              "text": "Placeholder text for multi-line input"
            }
          },
          "label": { "type": "plain_text", "text": "멤버 Email 목록" },
          "hint": { "type": "plain_text", "text": "여러명일 경우 콤마(,)로 구분해주세요." }
        }
      ]
    }
  }
}

interface IUser {
  id: string
  email: string
  isDeleted: boolean
  botId: string
  isBot: boolean
  isAdmin: boolean
  isOwner: boolean
}

const sectionMrkdwn = (text: string): SectionBlock => {
  return {
    "type": "section",
    "text": { "type": "mrkdwn", "text": text },
  }
}

interface IReportData {
  // mm: membership member
  mmEmails: string[]
  mmEmailsInChannel: string[]
  knownUsersWillBeInvited: IUser[]
  unknownEmailsWillBeInvited: string[]
  usersWillBeRemoved: IUser[]
  channelHumanEmails: string[]
}
const getReportArg = (channelId: string, userId: string, reportData: IReportData): ChatPostEphemeralArguments => {
  const { mmEmails, mmEmailsInChannel, knownUsersWillBeInvited, unknownEmailsWillBeInvited, usersWillBeRemoved, channelHumanEmails } = reportData
  const humansWillBeRemoved = usersWillBeRemoved.filter(o => !o.isBot)
  // const botsWillBeRemoved = usersWillBeRemoved.filter(o => o.isBot)

  return {
    text: '',
    channel: channelId,
    user: userId,
    blocks: [
      sectionMrkdwn(`:credit_card: 멤버쉽: *${mmEmails.length}*, 채널 멤버: *${channelHumanEmails.length}*, 채널 멤버쉽 멤버: *${mmEmailsInChannel.length}*`),
      // sectionMrkdwn(`*:credit_card: 채널 내 멤버쉽 유저*: ${mmEmailsInChannel.length}/${mmEmails.length}`),
      sectionMrkdwn(`*:handshake: 초대해야 할 멤버(${knownUsersWillBeInvited.length})*: ${knownUsersWillBeInvited.map(o => o.email).join(',')}`),
      sectionMrkdwn(`*:interrobang: 초대해야 하지만 워크스페이스에 없는 멤버(${unknownEmailsWillBeInvited.length})*: ${unknownEmailsWillBeInvited.join(',')}`),
      sectionMrkdwn(`*:no_entry_sign: 내보내야 할 멤버(${humansWillBeRemoved.length})*: ${humansWillBeRemoved.map(o => `<@${o.id}>`).join(',')}`),
      // sectionMrkdwn(`*:no_entry_sign: 내보내야 할 봇(${botsWillBeRemoved.length})*: ${botsWillBeRemoved.map(o => `@${o.id}`).join(',')}`),
    ]
  }
}

interface IMyViewSubmissionPayload extends ViewSubmissionPayload {
  type: 'view_submission'
  view: {
    state: any
    private_metadata: string
  }
}


const handleViewSubmission = async (payload: IMyViewSubmissionPayload) => {
  const Key = { teamId: payload.team.id }
  const result = await ddc.get({ TableName, Key }).promise()
  const wc = new WebClient(result.Item.accessToken)

  // TODO: yml 지원
  const value: string = payload.view.state?.values?.[COMMA_SEPARATED_EMAILS]?.emails?.value || ''
  const mmEmails = compact(value.split(',').map(email => email.trim()))

  const pm: IModalMainPM = JSON.parse(payload.view.private_metadata)
  const { channelId } = pm

  const channelMemberIds = await getChannelMembers(wc, channelId)
  console.log('channelMemberIdArr.length: ' + channelMemberIds.length)
  console.log('channelMemberIdArr: ' + channelMemberIds.join(','))

  const allMemberArr = await getAllMembers(wc)
  console.log('allMemberArr.length: ' + allMemberArr.length)
  console.log('allMemberArr[].id: ' + allMemberArr.map(o => o.id).join(','))

  const channelHumanEmails = compact(channelMemberIds.map(o => {
    const found = allMemberArr.find(wm => wm.id === o)
    return (found && !found.isBot) ? found.email : null
  }))
  console.log('channelUserEmails: ' + channelHumanEmails.join(','))

  const channelBotIds = compact(channelMemberIds.map(o => {
    const found = allMemberArr.find(wm => wm.id === o)
    return (found && found.isBot) ? found.id : null
  }))
  console.log('channelBotIds: ' + channelBotIds.join(','))

  const emailToUser = (email: string) => {
    return allMemberArr.find(o => o.email === email) || null
  }

  const mmEmailsInChannel = intersection(mmEmails, channelHumanEmails)
  const usersWillBeRemoved = difference(channelHumanEmails, mmEmailsInChannel).map(emailToUser)
  const emailsWillBeInvited = difference(mmEmails, mmEmailsInChannel)
  const knownUsersWillBeInvited = compact(emailsWillBeInvited.map(emailToUser))
  const unknownEmailsWillBeInvited = emailsWillBeInvited.filter(email => !emailToUser(email))

  const reportData = { mmEmails, mmEmailsInChannel, knownUsersWillBeInvited, unknownEmailsWillBeInvited, usersWillBeRemoved, channelHumanEmails }
  const arg = getReportArg(channelId, payload.user.id, reportData)
  await wc.chat.postEphemeral(arg)
  // await wc.chat.postMessage({ text: text, channel: channelId })

  return reportData
}

const getChannelMembers = async (wc: WebClient, channel: string): Promise<string[]> => {
  let cursor = void 0
  let arr: string[] = []
  let i = 0
  do {
    const res: ConversationsMembersResponse = await wc.conversations.members({ channel, cursor, limit: 1000 })
    arr = [...arr, ...res.members]

    cursor = res.response_metadata.next_cursor
    i++
  } while(cursor && i < 15)

  return arr
}

const slackMemberToUser = (o: Member) => {
  return {
    id: o.id, email: o.profile.email, botId: o.profile.bot_id, isDeleted: o.deleted,
    isAdmin: o.is_admin, isBot: o.is_bot, isOwner: o.is_owner,
  }
}

const getAllMembers = async (wc: WebClient): Promise<IUser[]> => {
  let cursor = void 0
  let users = []
  let i = 0
  do {
    const res: UsersListResponse = await wc.users.list({ cursor })
    const newUsers = res.members.map(slackMemberToUser)
      .filter(o => !o.isDeleted)
      .filter(o => o.id !== 'USLACKBOT')
    users = [...users, ...newUsers]
    cursor = res.response_metadata.next_cursor
    i++
  } while(cursor && i < 15)

  return users
}

const isViewSubmissionPayload = (o: any): o is IMyViewSubmissionPayload => {
  if (!o || typeof o !== 'object') return false
  if (o.type !== 'view_submission') return false

  return o?.view?.callback_id === MODAL_MAIN
}

export const action = async (event: APIGatewayEvent, _: Context) => {
  const eventBody = qs.parse(event.body) || {}
  if (typeof eventBody.payload !== 'string') return { statusCode: 500 }

  console.log(eventBody)

  const payload = JSON.parse(eventBody.payload)
  if (!isViewSubmissionPayload(payload)) {
    console.error('Wrong payload')
    return { statusCode: 500, body: 'Wrong payload' }
  }

  const [err,res] = await to(handleViewSubmission(payload))
  if (err) {
    console.error(JSON.stringify(err))
    return { statusCode: 500, body: 'error' }
  }

  return { statusCode: 200 }
}

export const test = async (event: APIGatewayEvent, _: Context) => {
  return { statusCode: 200, body: 'test' }
}

export const command = async (event: APIGatewayEvent, _: Context) => {
  const eventBody: SlashCommandPayload = qs.parse(event.body) || {}
  // console.log(eventBody)

  const Key = { teamId: eventBody.team_id }
  const result = await ddc.get({ TableName, Key }).promise()
  const wc = new WebClient(result.Item.accessToken)

  const [err,res] = await to(wc.views.open(modal(eventBody.trigger_id, eventBody.channel_id)))
  if (err) {
    console.error(JSON.stringify(err))
    return { statusCode: 500, body: JSON.stringify(err) }
  }

  return { statusCode: 200 }
}

export const index = async (event: APIGatewayEvent, _: Context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      version: process.env.GIT_REVISION || 'local',
      message: 'hello',
      input: event,
    }, null, 2),
  }
}

interface IOAuthAcessV2Result {
  ok: boolean
  app_id: string
  authed_user: { id: string }
  scope: string
  token_type: string
  access_token: string
  bot_user_id: string
  team: { id: string, name: string }
  enterprise_id: string | null
}

const isOAuthAccessV2SuccessResult = (data: any): data is IOAuthAcessV2Result => {
  if (!data || typeof data !== 'object') return false

  const { ok, app_id, authed_user, scope, token_type, access_token, bot_user_id, team, enterprise_id } = data
  if (!ok || typeof ok !== 'boolean') return false
  if (!access_token || typeof access_token !== 'string') return false
  if (!scope || typeof scope !== 'string') return false
  if (enterprise_id !== null && (!enterprise_id || typeof enterprise_id !== 'string')) return false
  return true
}

interface IQuery {
  state: string
  error?: string
  code?: string
}

const isIQuery = (query: any): query is IQuery => {
  if (!query || typeof query !== 'object') return false

  const { state, error, code } = query
  if (typeof state !== 'string') return false
  if (error !== void 0 && typeof error !== 'string') return false
  if (code !== void 0 && typeof code !== 'string') return false
  return true
}

export const oauth = async (event: APIGatewayEvent, _: Context) => {

  const query = event.queryStringParameters
  if (!isIQuery(query)) return { statusCode: 500, body: 'Wrong query' }
  if (query.error === 'access_denied') return { statusCode: 500, body: 'access denied' }

  const { code } = query
  const client_id = process.env.SCM_SLACK_CLIENT_ID
  const client_secret = process.env.SCM_SLACK_CLIENT_SECRET
  const url = 'https://slack.com/api/oauth.v2.access'

  const data = qs.stringify({ client_id, client_secret, code })
  const [err, result] = await to(axios.post<IOAuthAcessV2Result>(url, data))
  if (err || !result) return { statusCode: 500, body: 'wrong res or err'}

  const Item = {
    teamId: result.data.team.id,
    accessToken: result.data.access_token,
    app_id: result.data.app_id,
    authed_user: result.data.authed_user.id,
    scope: result.data.scope,
  }
  await ddc.put({ TableName, Item }).promise()
  console.log(result.data)

  return { statusCode: 200, body: 'good' }
}
