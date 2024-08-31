import { expect, type Locator, type Page } from '@playwright/test'
import { DocumentDetails, DocumentRights, DocumentStatus, NewDocument } from '../types'
import { DocumentCommonPage } from './document-common-page'
import { PlatformPassword } from '../../utils'
import { DocumentHistoryPage } from './document-history-page'

export class DocumentContentPage extends DocumentCommonPage {
  readonly page: Page
  readonly buttonDocumentTitle: Locator
  readonly buttonMoreActions: Locator
  readonly textDocumentStatus: Locator
  readonly textType: Locator
  readonly textCategory: Locator
  readonly textVersion: Locator
  readonly textStatus: Locator
  readonly textOwner: Locator
  readonly textAuthor: Locator
  readonly buttonSelectNewOwner: Locator
  readonly buttonSelectNewOwnerChange: Locator
  readonly buttonSendForReview: Locator
  readonly buttonSendForApproval: Locator
  readonly buttonAddMembers: Locator
  readonly buttonSelectMemberSubmit: Locator
  readonly textSelectReviewersPopup: Locator
  readonly textSelectApproversPopup: Locator
  readonly buttonCurrentRights: Locator
  readonly buttonAddMessageToText: Locator
  readonly buttonComments: Locator
  readonly textDocumentTitle: Locator
  readonly buttonCompleteReview: Locator
  readonly inputPassword: Locator
  readonly buttonSubmit: Locator
  readonly buttonReject: Locator
  readonly inputRejectionReason: Locator
  readonly buttonApprove: Locator
  readonly buttonEditDocument: Locator
  readonly buttonDraftNewVersion: Locator
  readonly buttonDocumentInformation: Locator
  readonly buttonDocument: Locator
  readonly buttonDocumentApprovals: Locator
  readonly textPageHeader: Locator
  readonly buttonSelectNewOwnerChangeByQaraManager: Locator
  readonly textId: Locator
  readonly contentLocator: Locator
  readonly addSpaceButton: Locator
  readonly inputSpaceName: Locator
  readonly roleSelector: Locator
  readonly selectRoleMember: Locator
  readonly createButton: Locator
  readonly createNewDocument: Locator
  readonly selectCustom: Locator
  readonly nextStepButton: Locator
  readonly customSpecificReason: Locator
  readonly newDocumentTitle: Locator
  readonly createDraft: Locator
  readonly draftNewVersion: Locator
  readonly buttonHistoryTab: Locator
  readonly documentHeader: Locator
  readonly leaveFolder: Locator
  readonly textContainer: Locator
  readonly myDocument: Locator
  readonly library: Locator
  readonly templates: Locator
  readonly categories: Locator
  readonly addCategoryButton: Locator
  readonly categoryTitle: Locator
  readonly description: Locator
  readonly categoryCode: Locator
  readonly generalDocumentation: Locator
  readonly newDocumentArrow: Locator
  readonly newTemplate: Locator
  readonly filter: Locator
  readonly filterCategory: Locator

  constructor (page: Page) {
    super(page)
    this.page = page
    this.buttonDocumentTitle = page.locator('button.version-item span.name')
    this.buttonMoreActions = page.locator('.hulyHeader-buttonsGroup > .no-print > .antiButton').first()
    this.textDocumentStatus = page.locator('button.version-item div.root span.label')
    this.textType = page.locator('div.flex:has(div.label:text("Template name")) div.field')
    this.textCategory = page.locator('div.flex:has(div.label:text("Category")) div.field')
    this.textVersion = page.locator('div.flex:has(div.label:text("Version")) div.field')
    this.textStatus = page.locator('div.flex:has(div.label:text("Status")) div.field')
    this.textOwner = page.locator('div.flex:has(div.label:text("Owner")) div.field')
    this.textAuthor = page.locator('div.flex:has(div.label:text("Author")) div.field')
    this.buttonSelectNewOwner = page.locator('div.popup button.small')
    this.buttonSelectNewOwnerChange = page.locator('div.popup button.dangerous')
    this.buttonSendForReview = page.locator('div.hulyHeader-buttonsGroup.extra button[type="button"] > span', {
      hasText: 'Send for review'
    })
    this.buttonSendForApproval = page.locator('div.hulyHeader-buttonsGroup.extra button[type="button"] > span', {
      hasText: 'Send for approval'
    })
    this.buttonAddMembers = page.locator('div.popup div.addButton')
    this.buttonSelectMemberSubmit = page.locator('div.popup div.footer button[type="submit"]')
    this.textSelectReviewersPopup = page.locator('div.popup span.label', { hasText: 'Select reviewers' })
    this.textSelectApproversPopup = page.locator('div.popup span.label', { hasText: 'Select approvers' })
    this.buttonCurrentRights = page.locator(
      'div.hulyHeader-buttonsGroup.extra button[type="button"] > span[slot="content"]'
    )
    this.buttonAddMessageToText = page.locator('div.text-editor-toolbar > button:last-child')
    this.buttonComments = page.locator('button[id$="comment"]')
    this.textDocumentTitle = page.locator('div.panel div.title')
    this.buttonCompleteReview = page.locator('div.hulyHeader-buttonsGroup.extra button[type="button"] > span', {
      hasText: 'Complete review'
    })
    this.inputPassword = page.locator('input[name="documents:string:Password"]')
    this.buttonSubmit = page.locator('div.popup button[type="submit"]')
    this.buttonReject = page.locator('button[type="button"] > span', { hasText: 'Reject' })
    this.inputRejectionReason = page.locator('div.popup div[id="rejection-reason"] input')
    this.buttonApprove = page.locator('button[type="button"] > span', { hasText: 'Approve' })
    this.buttonDocument = page.locator('button[id$="info"]')
    this.buttonEditDocument = page.locator('div.hulyHeader-buttonsGroup.extra button[type="button"] > span', {
      hasText: 'Edit document'
    })
    this.buttonDraftNewVersion = page.locator('div.hulyHeader-buttonsGroup.extra button[type="button"] > span', {
      hasText: 'Draft new version'
    })
    this.buttonDocumentInformation = page.locator('button[id$="info"]')
    this.buttonDocumentApprovals = page.locator('button[id$="approvals"]')
    this.textPageHeader = page.locator('div.hulyNavPanel-header')
    this.buttonSelectNewOwnerChangeByQaraManager = page.locator('div.popup button[type="submit"]')
    this.textId = page.locator('div.flex:has(div.label:text("ID")) div.field')
    this.contentLocator = page.locator('div.textInput div.tiptap')
    this.addSpaceButton = page.locator('#tree-orgspaces')
    this.inputSpaceName = page.getByPlaceholder('New documents space')
    this.roleSelector = page.getByRole('button', { name: 'Members' })
    this.selectRoleMember = page.getByRole('button', { name: 'AJ Appleseed John' })
    this.createButton = page.getByRole('button', { name: 'Create' })
    this.createNewDocument = page.getByRole('button', { name: 'Create new document' })
    this.selectCustom = page.getByText('Custom')
    this.customSpecificReason = page.getByPlaceholder('Specify the reason...')
    this.nextStepButton = page.getByRole('button', { name: 'Next step' })
    this.newDocumentTitle = page.getByPlaceholder('New document')
    this.createDraft = page.getByRole('button', { name: 'Create Draft' })
    this.draftNewVersion = page.getByRole('button', { name: 'Draft new version' })
    this.buttonHistoryTab = page.getByText('History')
    this.documentHeader = page.getByRole('button', { name: 'Complete document' })
    this.leaveFolder = page.getByRole('button', { name: 'Leave' })
    this.textContainer = page.locator('.tiptap')
    this.myDocument = page.getByRole('button', { name: 'Categories' })
    this.library = page.getByRole('button', { name: 'Library' })
    this.templates = page.getByRole('button', { name: 'Templates' })
    this.categories = page.getByRole('button', { name: 'Categories' })
    this.addCategoryButton = page.getByRole('button', { name: 'Category', exact: true })
    this.categoryTitle = page.getByPlaceholder('Title')
    this.description = page.getByRole('paragraph')
    this.categoryCode = page.getByPlaceholder('Code')
    this.generalDocumentation = page.getByRole('button', { name: 'General documentation' })
    this.newDocumentArrow = page.locator('.w-full > button:nth-child(2)')
    this.newTemplate = page.getByRole('button', { name: 'New template', exact: true })
    this.filter = page.getByRole('button', { name: 'Filter' })
    this.filterCategory = page.locator('span').filter({ hasText: /^Category$/ })
  }

  async checkDocumentTitle (title: string): Promise<void> {
    await expect(this.buttonDocumentTitle).toContainText(title)
  }

  async clickDocumentHeader (name: string): Promise<void> {
    await this.page.getByRole('button', { name }).click()
  }

  async clickOnAddCategoryButton (): Promise<void> {
    await this.addCategoryButton.click()
  }

  async clickNewDocumentArrow (): Promise<void> {
    await this.newDocumentArrow.click()
  }

  async clickNewTemplate (): Promise<void> {
    await this.newTemplate.click()
  }

  async selectControlDocumentSubcategory (
    buttonName: 'My Document' | 'Library' | 'Templates' | 'Categories' | 'General documentation'
  ): Promise<void> {
    switch (buttonName) {
      case 'My Document':
        await this.myDocument.click()
        break
      case 'Library':
        await this.library.click()
        break
      case 'Templates':
        await this.templates.click()
        break
      case 'Categories':
        await this.categories.click()
        break
      case 'General documentation':
        await this.generalDocumentation.click()
        break
      default:
        throw new Error('Unknown button')
    }
  }

  async fillCategoryForm (categoryTitle: string, description: string, categoryCode: string): Promise<void> {
    await this.categoryTitle.fill(categoryTitle)
    await this.description.fill(description)
    await this.categoryCode.fill(categoryCode)
    await this.createButton.click()
  }

  async checkIfCategoryIsCreated (categoryTitle: string, categoryCode: string): Promise<void> {
    await expect(this.page.getByText(categoryTitle)).toBeVisible()
    await expect(this.page.getByRole('link', { name: categoryCode })).toBeVisible()
  }

  async checkIfTextExists (text: string): Promise<void> {
    await expect(this.textContainer).toContainText(text)
  }

  async hoverOverGeneralDocumentation (): Promise<void> {
    await this.generalDocumentation.hover()
  }

  async addReasonAndImpactToTheDocument (description: string, reason: string): Promise<void> {
    await this.page.getByText('Reason & Impact').click()
    await this.page.getByPlaceholder('Describe what was changed...').fill(description)
    await this.page.getByPlaceholder('Describe why it was changed...').click()
    await this.page.getByPlaceholder('Describe why it was changed...').fill(reason)
  }

  async selectRelease (version: string): Promise<void> {
    await this.page.getByText('Release', { exact: true }).click()
    if (version === 'Major') {
      await this.page.getByText('Major').click()
    }
    if (version === 'Minor') {
      await this.page.getByText('Minor').click()
    }
  }

  async addContent (content: string, append: boolean = false, newParagraph: boolean = false): Promise<void> {
    if (newParagraph) {
      await this.contentLocator.press('Enter')
    }

    if (append) {
      await this.contentLocator.pressSequentially(content)
    } else {
      await this.contentLocator.fill(content)
    }
  }

  async replaceContent (content: string): Promise<void> {
    await this.contentLocator.clear({ force: true })
    await this.contentLocator.fill(content)
  }

  async checkContent (content: string): Promise<void> {
    await expect(this.contentLocator).toHaveText(content)
  }

  async executeMoreActions (action: string): Promise<void> {
    await this.buttonMoreActions.click()
    await this.selectFromDropdown(this.page, action)
  }

  async checkIfFolderExists (folderName: string): Promise<void> {
    await expect(this.page.getByRole('button', { name: folderName })).toBeVisible()
  }

  async clickAddFolderButton (): Promise<void> {
    await this.addSpaceButton.click()
  }

  async chooseFilter (category: string): Promise<void> {
    await this.filter.click()
    await this.filterCategory.hover()
    await this.page.getByRole('button', { name: 'Category', exact: true }).click()
    await this.page.getByText(category).click({ force: true })
    await this.page.keyboard.press('Escape')
  }

  async checkIfFilterIsApplied (code: string): Promise<void> {
    await expect(this.page.getByText(code, { exact: true })).toBeVisible()
  }

  async fillDocumentSpaceForm (spaceName: string): Promise<void> {
    await this.inputSpaceName.fill(spaceName)
    await this.roleSelector.nth(2).click()
    await this.selectRoleMember.nth(2).click()
    await this.page.keyboard.press('Escape')
    await this.selectRoleMember.nth(1).click()
    await this.page.getByRole('button', { name: 'DK Dirak Kainin' }).click()
    await this.page.keyboard.press('Escape')
    await this.page.waitForTimeout(1000)
    await this.createButton.click()
  }

  async checkSpaceFormIsCreated (spaceName: string): Promise<void> {
    await expect(this.page.getByRole('button', { name: spaceName })).toBeVisible()
  }

  async createNewDocumentInsideFolder (folderName: string): Promise<void> {
    await this.page.getByRole('button', { name: folderName }).hover()
    await this.page.getByRole('button', { name: folderName }).getByRole('button').click()
    await this.createNewDocument.click()
  }

  async clickLeaveFolder (folderName: string): Promise<void> {
    await this.page.getByRole('button', { name: folderName }).hover()
    await this.page.getByRole('button', { name: folderName }).getByRole('button').click()
    await this.leaveFolder.click()
  }

  async createNewDocumentFromFolder (
    title: string,
    custom: boolean = false,
    specificReason: string = ''
  ): Promise<void> {
    await this.page.locator('.antiRadio > .marker').first().click()
    await this.nextStepButton.click()
    await this.newDocumentTitle.fill(title)
    if (custom) {
      await this.selectCustom.click()
      await this.customSpecificReason.fill(specificReason)
    }
    await this.nextStepButton.click()
    await this.createDraft.click()
  }

  async clickSendForApproval (): Promise<void> {
    await this.buttonSendForApproval.click()
  }

  async clickDraftNewVersion (): Promise<void> {
    await this.buttonDraftNewVersion.click()
  }

  async clickHistoryTab (): Promise<void> {
    await this.buttonHistoryTab.first().click()
  }

  async createNewDraft (): Promise<void> {
    await this.buttonEditDocument.click()
    // It's important to wait for the draft status to make sure the content
    // is editable for the next steps
    await this.checkDocumentStatus(DocumentStatus.DRAFT)
  }

  async checkIfHistoryVersionExists (description: string): Promise<void> {
    await this.page.waitForTimeout(200)
    await expect(this.page.getByText(description)).toBeVisible()
    await expect(this.page.getByText('v0.1', { exact: true })).toBeVisible()
  }

  async checkDocumentStatus (status: DocumentStatus): Promise<void> {
    await expect(this.textDocumentStatus).toHaveText(status)
  }

  async checkDocument (data: DocumentDetails): Promise<void> {
    if (data.type != null && data.type !== 'N/A') {
      await expect(this.textType).toHaveText(data.type)
    }
    if (data.category != null) {
      await expect(this.textCategory).toContainText(data.category)
    }
    if (data.version != null) {
      await expect(this.textVersion).toHaveText(data.version)
    }
    if (data.status != null) {
      await expect(this.textStatus).toHaveText(data.status)
    }
    if (data.owner != null) {
      await expect(this.textOwner).toHaveText(data.owner)
    }
    if (data.author != null) {
      await expect(this.textAuthor).toHaveText(data.author)
    }
    if (data.id != null) {
      await expect(this.textId).toHaveText(data.id)
    }
  }

  async fillChangeDocumentOwnerPopup (newOwner: string): Promise<void> {
    await this.buttonSelectNewOwner.click()
    await this.selectListItemWithSearch(this.page, newOwner)
    await this.buttonSelectNewOwnerChange.click()
  }

  async fillSelectReviewersForm (reviewers: Array<string>): Promise<void> {
    await this.buttonAddMembers.click()
    for (const reviewer of reviewers) {
      await this.selectListItemWithSearch(this.page, reviewer)
    }
    await this.textSelectReviewersPopup.click({ force: true })
    await this.buttonSelectMemberSubmit.click()
  }

  async fillSelectApproversForm (approvers: Array<string>): Promise<void> {
    await this.buttonAddMembers.click()
    for (const approver of approvers) {
      await this.selectListItemWithSearch(this.page, approver)
    }
    await this.textSelectApproversPopup.click({ force: true })
    await this.buttonSelectMemberSubmit.click()
  }

  async checkCurrentRights (right: DocumentRights): Promise<void> {
    await expect(this.buttonCurrentRights).toHaveText(right)
  }

  async addMessageToTheText (text: string, message: string, closePopup: boolean = true): Promise<void> {
    await this.page.getByText(text).click()
    await this.page.getByText(text).dblclick()

    await this.buttonAddMessageToText.click()
    await this.addMessage(message)

    if (closePopup) {
      await this.closeNewMessagePopup()
    }
  }

  async sendForApproval (
    releaseType: string,
    version: string,
    reason: string,
    impact: string,
    prevVersion: string,
    newVersion: string,
    userPage: Page,
    completeDocument: NewDocument,
    documentDetails: DocumentDetails
  ): Promise<void> {
    const documentContentPageSecond = new DocumentContentPage(userPage)

    await this.clickDraftNewVersion()
    await this.selectRelease(releaseType)
    await this.addReasonAndImpactToTheDocument(reason, impact)
    await this.buttonSendForApproval.click()
    await this.buttonSelectMemberSubmit.click()
    await this.checkDocumentStatus(DocumentStatus.IN_APPROVAL)
    await this.checkDocument({
      ...documentDetails,
      status: DocumentStatus.IN_APPROVAL,
      version
    })
    await this.checkCurrentRights(DocumentRights.VIEWING)
    await documentContentPageSecond.clickDocumentHeader(completeDocument.title + ' ' + prevVersion)
    await documentContentPageSecond.clickDocumentHeader(completeDocument.title + ' ' + newVersion)
    await documentContentPageSecond.confirmApproval()
    await this.buttonHistoryTab.first().click()
    const documentHistoryPage = new DocumentHistoryPage(this.page)
    await documentHistoryPage.checkHistoryEventExist('New document creation')
    await documentHistoryPage.checkHistoryEventExist(reason)
  }

  async clickPreviousVersionHeader (userPage: Page, completeDocument: NewDocument, prevVersion: string): Promise<void> {
    const documentContentPageSecond = new DocumentContentPage(userPage)
    await documentContentPageSecond.clickDocumentHeader(completeDocument.title + ' ' + prevVersion)
  }

  async closeNewMessagePopup (): Promise<void> {
    await this.textPageHeader.press('Escape', { delay: 300 })
    await this.textPageHeader.click({ force: true, delay: 300, position: { x: 1, y: 1 } })
  }

  async completeReview (): Promise<void> {
    await this.buttonCompleteReview.click()
    await this.inputPassword.fill(PlatformPassword)
    await this.buttonSubmit.click()
  }

  async confirmRejection (rejectionReason: string): Promise<void> {
    await this.buttonReject.click()
    await this.inputPassword.fill(PlatformPassword)
    await this.inputRejectionReason.fill(rejectionReason)
    await this.buttonSubmit.click()
  }

  async confirmApproval (): Promise<void> {
    await this.buttonApprove.click()
    await this.inputPassword.fill(PlatformPassword)
    await this.buttonSubmit.click()
  }

  async changeCurrentRight (newRight: DocumentRights): Promise<void> {
    await this.buttonCurrentRights.click()
    await this.selectMenuItem(this.page, newRight)
  }

  async checkComparingTextAdded (text: string): Promise<void> {
    await expect(this.page.locator('span.text-editor-highlighted-node-add', { hasText: text }).first()).toBeVisible()
  }

  async checkComparingTextDeleted (text: string): Promise<void> {
    await expect(this.page.locator('span.text-editor-highlighted-node-delete', { hasText: text }).first()).toBeVisible()
  }

  async openApprovals (): Promise<void> {
    await expect(this.buttonDocumentApprovals).toBeVisible()
    await this.buttonDocumentApprovals.click({ position: { x: 1, y: 1 }, force: true })
  }

  async fillChangeDocumentOwnerPopupByQaraManager (newOwner: string): Promise<void> {
    await this.buttonSelectNewOwner.click()
    await this.selectListItemWithSearch(this.page, newOwner)
    await this.buttonSelectNewOwnerChangeByQaraManager.click()
  }
}
